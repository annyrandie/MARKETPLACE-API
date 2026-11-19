import { randomUUID } from 'node:crypto';
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type Part,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Pool } from 'pg';
import { ALLOWED_TYPES, MAGIC_BYTES, partRange, planUpload } from './upload-policy';

/** An Error carrying the HTTP status app.js's problem+json filter reads. */
export class FileError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface FilesServiceOptions {
  bucket: string;
  /** single-PUT URL lifetime (UPLOAD_URL_TTL_SECONDS) */
  putUrlTtlSeconds: number;
  /** Ids only — a presigned URL never goes into a log: it IS the access. */
  audit: (event: string, fields: Record<string, unknown>) => void;
}

// A part URL may wait for its turn behind the other parts of a big file,
// so it lives longer than a single PUT — but it's re-issued on demand
// (GET /uploads/:id/parts), so it never needs to outlive a resume.
export const PART_URL_TTL_SECONDS = 15 * 60;
// GET /files/:id answers with a 302 that the client follows immediately.
export const DOWNLOAD_URL_TTL_SECONDS = 60;

interface FileRow {
  id: string;
  owner_id: string;
  key: string;
  status: 'PENDING' | 'COMPLETED';
  content_type: string;
  expected_size: string;
  size: string | null;
  etag: string | null;
  original_name: string | null;
  upload_id: string | null;
  part_size: number | null;
  parts_count: number | null;
}

export interface IntentRequest {
  filename?: string;
  contentType: string;
  size: number;
}

export interface PresignedPart {
  part_number: number;
  url: string;
  /** byte range of the file this part carries, inclusive */
  start: number;
  end: number;
}

/**
 * The file path: intent → bytes go STRAIGHT to the storage on a presigned
 * URL (this service is not in the data path) → commit, where the service
 * checks with the storage itself what actually arrived.
 */
export class FilesService {
  constructor(
    private readonly pool: Pool,
    private readonly s3: S3Client,
    private readonly opts: FilesServiceOptions,
  ) {}

  /**
   * Step 1. The caller is authenticated (requireAuth); the server decides
   * the key — `uploads/{owner}/{uuid}.{ext}`, the extension from the
   * content-type allowlist. The client's filename never reaches the key: a
   * key built from it would let the client write anywhere in the bucket
   * (`../../`, someone else's prefix, an existing object).
   *
   * With an Idempotency-Key, the row is CLAIMED first (ON CONFLICT DO
   * NOTHING): a double tap gets the same file back, with fresh URLs, and
   * never creates a second object or a second multipart upload.
   */
  async intent(ownerId: string, req: IntentRequest, idempotencyKey?: string) {
    const type = ALLOWED_TYPES[req.contentType];
    if (!type) throw new FileError(415, `content type "${req.contentType}" is not allowed`);
    if (!Number.isSafeInteger(req.size) || req.size <= 0) throw new FileError(400, 'size must be a positive integer');
    if (req.size > type.maxBytes) throw new FileError(413, `${req.contentType} is limited to ${type.maxBytes} bytes`);

    const key = `uploads/${ownerId}/${randomUUID()}.${type.ext}`;
    const plan = planUpload(req.size);
    const originalName = (req.filename ?? '').slice(0, 255) || null; // display only

    const { rows } = await this.pool.query<FileRow>(
      `INSERT INTO files (owner_id, key, content_type, expected_size, original_name, part_size, parts_count, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (owner_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING *`,
      [
        ownerId,
        key,
        req.contentType,
        req.size,
        originalName,
        plan.mode === 'multipart' ? plan.partSize : null,
        plan.mode === 'multipart' ? plan.partsCount : null,
        idempotencyKey ?? null,
      ],
    );

    let file = rows[0];
    let replayed = false;
    if (!file) {
      // lost the claim: this Idempotency-Key already has a file
      file = await this.byIdempotencyKey(ownerId, idempotencyKey!);
      if (file.content_type !== req.contentType || Number(file.expected_size) !== req.size) {
        throw new FileError(422, 'this Idempotency-Key was already used for a different upload');
      }
      replayed = true;
    } else if (plan.mode === 'multipart') {
      const mp = await this.s3.send(
        new CreateMultipartUploadCommand({ Bucket: this.opts.bucket, Key: file.key, ContentType: file.content_type }),
      );
      await this.pool.query(`UPDATE files SET upload_id = $2 WHERE id = $1`, [file.id, mp.UploadId]);
      file.upload_id = mp.UploadId!;
    }
    this.opts.audit(replayed ? 'upload_intent_replayed' : 'upload_intent', { file_id: file.id, key: file.key, owner_id: ownerId });
    return { ...(await this.instructions(file)), replayed };
  }

  /**
   * The resume point for multipart. ListParts asks the STORAGE what it
   * already has — not the client's memory, not a column of ours — and
   * presigns only the missing parts. A new process after a crash calls
   * exactly this and uploads exactly what's missing.
   */
  async parts(ownerId: string, fileId: string) {
    const file = await this.owned(ownerId, fileId);
    if (!file.upload_id) throw new FileError(409, 'not a multipart upload');
    if (file.status === 'COMPLETED') throw new FileError(409, 'upload already completed');
    const uploaded = await this.listParts(file);
    return {
      file_id: file.id,
      part_size: file.part_size!,
      parts_count: file.parts_count!,
      uploaded: uploaded.map((p) => ({ part_number: p.PartNumber!, size: p.Size! })),
      missing: await this.presignParts(file, new Set(uploaded.map((p) => p.PartNumber!))),
      expires_in: PART_URL_TTL_SECONDS,
    };
  }

  /**
   * Step 3. Trust nothing the client says about the upload — ask the
   * storage. Without this, a client "commits" bytes it never sent and the
   * database lists a file that doesn't exist.
   *
   * multipart: ListParts → all parts there, each the planned size →
   *   CompleteMultipartUpload with the ETags the STORAGE reported.
   * then, for both: HeadObject → exists? size === the size declared at
   *   intent? → the first bytes match the declared type? → COMPLETED.
   * A mismatch deletes the object: it's not a file we agreed to store.
   */
  async commit(ownerId: string, fileId: string) {
    const file = await this.owned(ownerId, fileId);
    if (file.status === 'COMPLETED') return this.view(file); // commit is idempotent

    if (file.upload_id) await this.completeMultipart(file);

    const head = await this.s3.send(new HeadObjectCommand({ Bucket: this.opts.bucket, Key: file.key })).catch((err) => {
      if (err?.$metadata?.httpStatusCode === 404) return null;
      throw err;
    });
    if (!head) throw new FileError(409, 'no object has been uploaded for this file yet');

    const expected = Number(file.expected_size);
    if (head.ContentLength !== expected) {
      await this.deleteObject(file, 'size_mismatch');
      throw new FileError(409, `uploaded ${head.ContentLength} bytes, ${expected} were declared — object discarded`);
    }

    const first = await this.s3.send(
      new GetObjectCommand({ Bucket: this.opts.bucket, Key: file.key, Range: `bytes=0-${MAGIC_BYTES - 1}` }),
    );
    const headBytes = Buffer.from(await first.Body!.transformToByteArray());
    if (!ALLOWED_TYPES[file.content_type].magic(headBytes)) {
      await this.deleteObject(file, 'type_mismatch');
      throw new FileError(422, `content is not ${file.content_type} — object discarded`);
    }

    const { rows } = await this.pool.query<FileRow>(
      `UPDATE files SET status = 'COMPLETED', size = $2, etag = $3, completed_at = now()
        WHERE id = $1 AND status = 'PENDING' RETURNING *`,
      [file.id, head.ContentLength, head.ETag],
    );
    const done = rows[0] ?? (await this.owned(ownerId, fileId)); // a concurrent commit won — same result
    this.opts.audit('upload_committed', { file_id: file.id, key: file.key, size: head.ContentLength });
    return this.view(done);
  }

  /**
   * GET /files/:id → 302 to a fresh, one-minute presigned GET. A presigned
   * URL can't be revoked (no jti, no registry), so it's never handed out
   * long-lived (e.g. in an e-mail): this endpoint keeps the guard on EVERY
   * access, while the bytes still never pass through this service.
   */
  async downloadUrl(ownerId: string, fileId: string): Promise<string> {
    const file = await this.owned(ownerId, fileId);
    if (file.status !== 'COMPLETED') throw new FileError(409, 'upload not completed yet');
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.opts.bucket, Key: file.key }), {
      expiresIn: DOWNLOAD_URL_TTL_SECONDS,
    });
  }

  // ─── internals ──────────────────────────────────────────────────────────

  private async instructions(file: FileRow) {
    const base = { file_id: file.id, key: file.key, status: file.status };
    if (!file.upload_id) {
      const url = await getSignedUrl(
        this.s3,
        // ContentType and ContentLength are SIGNED: the client must PUT
        // exactly the declared type and number of bytes, or the storage
        // itself refuses with SignatureDoesNotMatch.
        new PutObjectCommand({
          Bucket: this.opts.bucket,
          Key: file.key,
          ContentType: file.content_type,
          ContentLength: Number(file.expected_size),
        }),
        { expiresIn: this.opts.putUrlTtlSeconds },
      );
      return {
        ...base,
        mode: 'single' as const,
        expires_in: this.opts.putUrlTtlSeconds,
        put: { url, headers: { 'content-type': file.content_type } },
      };
    }
    const uploaded = await this.listParts(file);
    return {
      ...base,
      mode: 'multipart' as const,
      expires_in: PART_URL_TTL_SECONDS,
      part_size: file.part_size!,
      parts_count: file.parts_count!,
      parts: await this.presignParts(file, new Set(uploaded.map((p) => p.PartNumber!))),
    };
  }

  private async presignParts(file: FileRow, have: Set<number>): Promise<PresignedPart[]> {
    const size = Number(file.expected_size);
    const out: PresignedPart[] = [];
    for (let n = 1; n <= file.parts_count!; n++) {
      if (have.has(n)) continue;
      const url = await getSignedUrl(
        this.s3,
        new UploadPartCommand({ Bucket: this.opts.bucket, Key: file.key, UploadId: file.upload_id!, PartNumber: n }),
        { expiresIn: PART_URL_TTL_SECONDS },
      );
      out.push({ part_number: n, url, ...partRange(n, file.part_size!, size) });
    }
    return out;
  }

  private async listParts(file: FileRow): Promise<Part[]> {
    const parts: Part[] = [];
    let marker: string | undefined;
    for (;;) {
      // ≤ 1 000 parts per call — up to 10 calls for a 10 000-part upload
      const page = await this.s3.send(
        new ListPartsCommand({ Bucket: this.opts.bucket, Key: file.key, UploadId: file.upload_id!, PartNumberMarker: marker }),
      );
      parts.push(...(page.Parts ?? []));
      if (!page.IsTruncated) return parts;
      marker = page.NextPartNumberMarker;
    }
  }

  private async completeMultipart(file: FileRow): Promise<void> {
    const parts = (await this.listParts(file)).sort((a, b) => a.PartNumber! - b.PartNumber!);
    const size = Number(file.expected_size);
    const missing: number[] = [];
    for (let n = 1; n <= file.parts_count!; n++) if (!parts.some((p) => p.PartNumber === n)) missing.push(n);
    if (missing.length) throw new FileError(409, `parts not uploaded yet: ${missing.join(', ')}`);
    for (const p of parts) {
      const { start, end } = partRange(p.PartNumber!, file.part_size!, size);
      if (p.Size !== end - start + 1) throw new FileError(409, `part ${p.PartNumber} is ${p.Size} bytes, expected ${end - start + 1}`);
    }
    try {
      await this.s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.opts.bucket,
          Key: file.key,
          UploadId: file.upload_id!,
          MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.PartNumber, ETag: p.ETag })) },
        }),
      );
    } catch (err) {
      const name = (err as { name?: string }).name;
      // NoSuchUpload: a previous commit already completed it — HeadObject decides
      if (name !== 'NoSuchUpload') throw new FileError(409, `storage refused to complete the upload: ${name}`);
    }
  }

  private async deleteObject(file: FileRow, reason: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: file.key }));
    this.opts.audit('upload_rejected', { file_id: file.id, key: file.key, reason });
  }

  private async owned(ownerId: string, fileId: string): Promise<FileRow> {
    if (!/^[0-9a-f-]{36}$/i.test(fileId)) throw new FileError(404, `file "${fileId}" was not found`);
    const { rows } = await this.pool.query<FileRow>(`SELECT * FROM files WHERE id = $1`, [fileId]);
    const file = rows[0];
    if (!file) throw new FileError(404, `file "${fileId}" was not found`);
    // ownership on the loaded row (HW #24's rule): authenticated, not yours → 403
    if (file.owner_id !== ownerId) throw new FileError(403, `file "${fileId}" does not belong to the caller`);
    return file;
  }

  private async byIdempotencyKey(ownerId: string, key: string): Promise<FileRow> {
    const { rows } = await this.pool.query<FileRow>(`SELECT * FROM files WHERE owner_id = $1 AND idempotency_key = $2`, [
      ownerId,
      key,
    ]);
    return rows[0];
  }

  private view(file: FileRow) {
    return {
      file_id: file.id,
      key: file.key,
      status: file.status,
      content_type: file.content_type,
      size: Number(file.size ?? file.expected_size),
      etag: file.etag,
    };
  }
}
