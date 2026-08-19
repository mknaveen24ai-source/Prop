/**
 * Migration 036: Certificate & auto-award system
 * ─────────────────────────────────────────────────────────────────────────────
 * Traders hit real milestones — passing a phase, reaching funded, being paid a
 * payout — and nothing marked the moment. These two tables back an automatic,
 * publicly verifiable certificate for each one.
 *
 * TWO THINGS ARE PINNED AT ISSUE TIME, for the same reason: a certificate is a
 * statement about a moment, and it gets downloaded, emailed and shared.
 *
 *   - `recipient_name` snapshots users.full_name, so a later profile edit
 *     cannot silently rewrite a certificate somebody has already posted.
 *   - `template_id` pins the exact artwork version, so re-designing a template
 *     cannot retroactively change certificates already in the wild.
 *
 * `certificate_templates` rows are therefore treated as IMMUTABLE VERSIONS.
 * Editing a template inserts a new row (version + 1) and deactivates the old
 * one; existing certificates keep rendering against the version they pinned.
 * The admin "re-issue" action is the deliberate way to move one forward.
 *
 * `source_key` is the idempotency story. Certificates are minted inside the
 * promotion/payout transaction, which can be retried, double-clicked or
 * replayed. The partial unique index below makes the insert
 * `ON CONFLICT (source_key) DO NOTHING`, so an empty result means "already
 * issued" rather than an error. Manual admin awards leave it NULL — the index
 * is partial precisely so those stay unconstrained.
 */

exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS certificate_templates (
      id            BIGSERIAL PRIMARY KEY,
      kind          TEXT,
      version       INTEGER NOT NULL DEFAULT 1,
      is_active     BOOLEAN NOT NULL DEFAULT TRUE,
      name          TEXT NOT NULL,
      image_path    TEXT NOT NULL,
      image_width   INTEGER NOT NULL,
      image_height  INTEGER NOT NULL,
      layout        JSONB NOT NULL DEFAULT '{}'::jsonb,
      uploaded_by   TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT certificate_templates_kind_check
        CHECK (kind IS NULL OR kind IN ('phase_passed','funded','payout','custom'))
    )
  `)

  // One active template per kind. COALESCE folds the default template (NULL
  // kind) into the same index — a plain UNIQUE(kind) would not, because NULLs
  // never conflict with each other in Postgres, so several "default" templates
  // could go active at once and resolution would be non-deterministic.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_certificate_templates_active_kind
      ON certificate_templates (COALESCE(kind, '__default__'))
      WHERE is_active
  `)

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS certificates (
      id              BIGSERIAL PRIMARY KEY,
      public_id       TEXT NOT NULL UNIQUE,
      user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id      UUID REFERENCES accounts(id),
      template_id     BIGINT REFERENCES certificate_templates(id),
      kind            TEXT NOT NULL,
      title           TEXT NOT NULL,
      subtitle        TEXT,
      recipient_name  TEXT NOT NULL,
      amount          NUMERIC(15,2),
      currency        TEXT NOT NULL DEFAULT 'USD',
      metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
      status          TEXT NOT NULL DEFAULT 'active',
      revoked_at      TIMESTAMPTZ,
      revoked_reason  TEXT,
      signature       TEXT NOT NULL,
      issued_by       TEXT,
      source_key      TEXT,
      issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT certificates_kind_check
        CHECK (kind IN ('phase_passed','funded','payout','custom')),
      CONSTRAINT certificates_status_check
        CHECK (status IN ('active','revoked'))
    )
  `)

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_certificates_source_key
      ON certificates (source_key)
      WHERE source_key IS NOT NULL
  `)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_certificates_user_issued ON certificates (user_id, issued_at DESC)`)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_certificates_kind        ON certificates (kind)`)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_certificates_status      ON certificates (status)`)
}

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS certificates`)
  await knex.raw(`DROP TABLE IF EXISTS certificate_templates`)
}
