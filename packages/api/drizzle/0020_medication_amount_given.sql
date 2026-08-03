-- How much was actually given, alongside how much is charted.
--
-- `medications.dose` is what the label or the chart says. This is what went in,
-- which is not always the same: half a tablet because that is what was left,
-- 7.5 mL drawn up rather than 10.
--
-- Free text and plaintext, exactly like `medications.dose`, and for the same
-- two reasons. It is the same kind of string, so storing one encrypted and the
-- other in the clear would only make a report join two worlds for no gain; and
-- nothing may ever convert, total or compare it, because software that does
-- arithmetic on doses is software that can get a dose wrong.
--
-- Nullable, and null means the record does not say. Nothing reads an empty
-- column as "the charted amount".

ALTER TABLE "medication_administrations"
  ADD COLUMN IF NOT EXISTS "amount_given" text;
