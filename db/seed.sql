-- Realistic volume + realistic skew. Nothing here is 33/33/33.
--
--   users        10 000
--   products    120 000  — the table q4 searches; "взуття" (footwear) is a
--                          deliberately small slice (~2%) so a two-word
--                          match ("шкіряні кросівки") lands at low single
--                          digits of the catalog, not 30%+ — see the hints
--                          in the assignment about selectivity killing the
--                          "no Seq Scan after" criterion through no fault
--                          of the index.
--   orders      150 000  — the main table; status skewed like the lecture
--                          (pending is the rare slice a partial index earns
--                          its keep on).
--   order_items ~300 000

INSERT INTO users (email, full_name, created_at)
SELECT
  'User' || gs || '@Example.COM', -- mixed case on purpose — q3 needs lower()
  'Клієнт ' || gs,
  now() - (random() * interval '900 days')
FROM generate_series(1, 10_000) AS gs;

-- Category buckets are skewed; footwear ("Взуття") is ~2% of the catalog,
-- and only about a third of THAT specifically pairs "шкіряні" with
-- "кросівки" — the two words q4's query searches for together.
INSERT INTO products (name, description, price, created_at)
SELECT
  CASE
    WHEN x.r < 0.02 THEN (ARRAY[
      'Шкіряні кросівки',
      'Шкіряні кросівки для бігу',
      'Спортивні кросівки',
      'Зимові черевики',
      'Літні сандалі',
      'Гумові чоботи'
    ])[x.variant]
    WHEN x.r < 0.13 THEN (ARRAY['Бавовняна футболка','Джинси класичні','Светр вовняний','Куртка зимова','Сукня літня','Спідниця джинсова'])[x.variant]
    WHEN x.r < 0.26 THEN (ARRAY['Бездротові навушники','Смартфон базовий','Ноутбук офісний','Планшет 10 дюймів','Розумний годинник','Портативна колонка'])[x.variant]
    WHEN x.r < 0.37 THEN (ARRAY['Стіл письмовий','Крісло офісне','Диван розкладний','Шафа для одягу','Полиця настінна','Ліжко двоспальне'])[x.variant]
    WHEN x.r < 0.48 THEN (ARRAY['Сковорода антипригарна','Набір каструль','Чайник електричний','Блендер потужний','Кавоварка домашня','Тостер компактний'])[x.variant]
    WHEN x.r < 0.60 THEN (ARRAY['Роман сучасний','Підручник з математики','Дитяча казка','Довідник кулінарний','Поетична збірка','Детектив бестселер'])[x.variant]
    WHEN x.r < 0.70 THEN (ARRAY['Конструктор дитячий','Лялька колекційна','Машинка на радіокеруванні','Пазл тисяча деталей','Плюшевий ведмедик','Настільна гра'])[x.variant]
    WHEN x.r < 0.81 THEN (ARRAY['Крем для обличчя','Шампунь відновлюючий','Парфуми жіночі','Туш для вій','Набір для манікюру','Гель для душу'])[x.variant]
    WHEN x.r < 0.92 THEN (ARRAY['Футбольний м''яч','Гантелі розбірні','Килимок для йоги','Велосипед міський','Рюкзак спортивний','Скакалка професійна'])[x.variant]
    ELSE                 (ARRAY['Ручка кулькова набір','Зошит клітинка','Папір офісний А4','Маркери кольорові','Степлер канцелярський','Клей олівець'])[x.variant]
  END AS name,
  CASE
    WHEN x.r < 0.02 THEN 'Якісне взуття з натуральної шкіри. Зручна колодка для щоденного носіння. Кросівки пасують і до спорту, і до прогулянки.'
    WHEN x.r < 0.13 THEN 'Стильний одяг на кожен день. Приємна тканина, вільний крій.'
    WHEN x.r < 0.26 THEN 'Сучасна електроніка з гарантією виробника. Швидка доставка по Україні.'
    WHEN x.r < 0.37 THEN 'Меблі для дому та офісу. Міцна конструкція, стильний дизайн.'
    WHEN x.r < 0.48 THEN 'Посуд для кухні щоденного використання. Легко миється.'
    WHEN x.r < 0.60 THEN 'Цікаве видання для дорослих та дітей. Тверда обкладинка, якісний друк.'
    WHEN x.r < 0.70 THEN 'Розвиваюча іграшка для дітей різного віку. Безпечні матеріали.'
    WHEN x.r < 0.81 THEN 'Косметичний засіб для щоденного догляду. Підходить для всіх типів шкіри.'
    WHEN x.r < 0.92 THEN 'Спортивний інвентар для тренувань удома чи в залі.'
    ELSE                 'Канцелярське приладдя для школи та офісу.'
  END AS description,
  round((random() * 5000 + 50)::numeric, 2),
  now() - (random() * interval '365 days')
FROM (
  SELECT random() AS r, 1 + (random() * 5)::int AS variant
  FROM generate_series(1, 120_000)
) AS x;

INSERT INTO orders (user_id, status, total_amount, created_at)
SELECT
  (random() * 9_999)::int + 1,
  CASE WHEN x.r < 0.90 THEN 'completed'
       WHEN x.r < 0.96 THEN 'pending'
       ELSE                 'cancelled' END,
  round((random() * 2000 + 20)::numeric, 2),
  now() - (random() * interval '730 days')
FROM (SELECT random() AS r FROM generate_series(1, 150_000)) AS x;

INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT
  (random() * 149_999)::int + 1,
  (random() * 119_999)::int + 1,
  (random() * 4)::int + 1,
  round((random() * 500 + 10)::numeric, 2)
FROM generate_series(1, 300_000);

-- Not ANALYZE alone: VACUUM sets the visibility map too. Without it, Index
-- Only Scan still visits the heap for every row (Heap Fetches: N in the
-- plan) and "after" buffers end up far worse than the index earned —
-- exactly the trap the assignment calls out.
VACUUM (ANALYZE);

SELECT 'users' AS table, count(*) FROM users
UNION ALL SELECT 'products', count(*) FROM products
UNION ALL SELECT 'orders', count(*) FROM orders
UNION ALL SELECT 'order_items', count(*) FROM order_items;

SELECT status, count(*) FROM orders GROUP BY status ORDER BY count DESC;
