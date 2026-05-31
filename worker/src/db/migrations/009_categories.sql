-- Rename legacy category labels to the new catalog taxonomy (2026-05).
UPDATE listings SET category = 'Дизайн и креатив' WHERE category = 'Дизайн и creative';
UPDATE listings SET category = 'Юридические услуги' WHERE category = 'Юриспруденция';
UPDATE listings SET category = 'Транспорт аренда и ремонт' WHERE category = 'Транспорт и логистика';
