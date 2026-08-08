CREATE TABLE IF NOT EXISTS users (
  id                INT           NOT NULL AUTO_INCREMENT,
  email             VARCHAR(255)  NOT NULL,
  first_name        VARCHAR(100)  NOT NULL,
  last_name         VARCHAR(100)  NOT NULL,
  email_verified_at DATETIME      NULL,
  last_login_at     DATETIME      NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS magic_tokens (
  id         INT          NOT NULL AUTO_INCREMENT,
  user_id    INT          NOT NULL,
  token      VARCHAR(64)  NOT NULL,
  purpose    VARCHAR(16)  NOT NULL,
  expires_at DATETIME     NOT NULL,
  used_at    DATETIME     NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_magic_token (token),
  KEY idx_magic_user (user_id),
  CONSTRAINT fk_magic_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  id           INT          NOT NULL AUTO_INCREMENT,
  user_id      INT          NOT NULL,
  token        VARCHAR(64)  NOT NULL,
  expires_at   DATETIME     NOT NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_agent   VARCHAR(255) NULL,
  ip_address   VARCHAR(64)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_session_token (token),
  KEY idx_session_user (user_id),
  CONSTRAINT fk_session_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS freq_directory (
  id         INT          NOT NULL AUTO_INCREMENT,
  name       VARCHAR(80)  NOT NULL,
  freq       VARCHAR(20)  NOT NULL,
  updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                          ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_freq_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS flight_plans (
  id         INT           NOT NULL AUTO_INCREMENT,
  user_id    INT           NOT NULL,
  name       VARCHAR(120)  NOT NULL,
  updated_at TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
                           ON UPDATE CURRENT_TIMESTAMP,
  plan_json  LONGTEXT      NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_user_name (user_id, name),
  KEY idx_user (user_id),
  CONSTRAINT fk_plan_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which aircraft a plan belongs to ('velis' | 'da20' | 'std').
-- NULL = pre-column row — bootstrap() backfills it from the bundle content.
-- NB: no semicolons inside comments — bootstrap() splits statements on ';'.
ALTER TABLE flight_plans
  ADD COLUMN IF NOT EXISTS aircraft VARCHAR(20) NULL AFTER name;
