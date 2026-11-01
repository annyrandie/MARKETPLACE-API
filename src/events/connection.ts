import amqp, { ChannelModel } from 'amqplib';

// BROKER_URL is read from process.env only — never hardcoded. Locally it
// comes from scripts/with-secrets.sh's file-based vault (defaulting to
// this repo's own docker-compose rabbitmq, not a secret); the grader's
// escape hatch exports it directly, same pattern as HW #16's
// PACT_BROKER_URL.
export function getBrokerUrl(): string {
  const url = process.env.BROKER_URL;
  if (!url) {
    throw new Error('BROKER_URL is not set — run via: bash scripts/with-secrets.sh dev <command>');
  }
  return url;
}

export async function connectBroker(): Promise<ChannelModel> {
  return amqp.connect(getBrokerUrl());
}
