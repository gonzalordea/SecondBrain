-- Interface theme chosen by the user; follows them across browsers and devices.
ALTER TABLE users ADD COLUMN theme text NOT NULL DEFAULT 'system' CHECK (theme IN ('system', 'light', 'dark'));
