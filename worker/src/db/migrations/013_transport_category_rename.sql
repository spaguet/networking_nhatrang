-- Rename transport category label (2026-06).
UPDATE listings SET category = 'Водители, аренда транспорта и ремонт' WHERE category = 'Транспорт аренда и ремонт';
