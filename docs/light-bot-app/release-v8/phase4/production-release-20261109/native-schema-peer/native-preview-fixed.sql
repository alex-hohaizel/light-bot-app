CREATE TABLE "lba_public_source_worker" (
	"id" boolean PRIMARY KEY NOT NULL,
	"uncertain" boolean NOT NULL,
	"hold_reason" text,
	CONSTRAINT "lba_public_source_worker_id_check" CHECK (id = true)
);

CREATE TABLE "lba_account_widget_proof_receipt" (
	"challenge_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" varchar(255) NOT NULL,
	"session_binding" char(64) NOT NULL,
	"auth_epoch" bigint NOT NULL,
	"proof_key" char(64) NOT NULL,
	"input_digest" char(64) NOT NULL,
	"result" jsonb NOT NULL,
	"committed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "lba_account_widget_proof_receipt_proof_key_key" UNIQUE("proof_key")
);

CREATE TABLE "lba_auth_proof_uses" (
	"proof_key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"bot_id" text NOT NULL,
	"claim_id" text NOT NULL,
	"state" text NOT NULL,
	"session_binding" text NOT NULL,
	"owner_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purpose" text DEFAULT 'login' NOT NULL,
	"challenge_binding" text,
	CONSTRAINT "lba_auth_proof_uses_kind_check" CHECK (kind = ANY (ARRAY['mini_app'::text, 'login'::text])),
	CONSTRAINT "lba_auth_proof_uses_purpose_check" CHECK (purpose = ANY (ARRAY['login'::text, 'account_link'::text])),
	CONSTRAINT "lba_auth_proof_uses_state_check" CHECK (state = ANY (ARRAY['claimed'::text, 'bound'::text]))
);

CREATE TABLE "lba_public_source_origin" (
	"origin" text PRIMARY KEY NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"uncertain" boolean NOT NULL,
	"hold_reason" text
);

CREATE TABLE "lba_account_link_challenge" (
	"id" uuid PRIMARY KEY NOT NULL,
	"nonce_hash" char(64) NOT NULL,
	"owner_id" varchar(255) NOT NULL,
	"session_binding" char(64) NOT NULL,
	"auth_epoch" bigint NOT NULL,
	"profile_session" text NOT NULL,
	"profile_revision" bigint NOT NULL,
	"state" text NOT NULL,
	"subject_id" varchar(255),
	"proof_key" char(64),
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "lba_account_link_challenge_nonce_hash_key" UNIQUE("nonce_hash"),
	CONSTRAINT "lba_account_link_challenge_proof_key_key" UNIQUE("proof_key"),
	CONSTRAINT "lba_account_link_challenge_auth_epoch_check" CHECK (auth_epoch >= 0),
	CONSTRAINT "lba_account_link_challenge_check" CHECK (expires_at > issued_at),
	CONSTRAINT "lba_account_link_challenge_state_check" CHECK (state = ANY (ARRAY['pending'::text, 'proved'::text, 'linked'::text, 'cancelled'::text]))
);

CREATE TABLE "lba_production_profile_origins" (
	"owner_id" varchar(255) PRIMARY KEY NOT NULL,
	"source_digest" char(64) NOT NULL,
	"projection_digest" char(64) NOT NULL,
	"private_provenance" jsonb NOT NULL,
	"imported_at" timestamp with time zone NOT NULL,
	"control_epoch" bigint NOT NULL
);

CREATE TABLE "lba_production_control" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"control_epoch" bigint NOT NULL,
	"writer_mode" text DEFAULT 'disabled' NOT NULL,
	CONSTRAINT "lba_production_control_control_epoch_check" CHECK ((control_epoch > 0) AND (control_epoch <= '9007199254740991'::bigint)),
	CONSTRAINT "lba_production_control_id_check" CHECK (id = true),
	CONSTRAINT "lba_production_control_writer_mode_check" CHECK (writer_mode = ANY (ARRAY['disabled'::text, 'legacy'::text, 'canonical'::text]))
);

CREATE TABLE "lba_public_source_raw" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "lba_public_source_raw_run_id_key" UNIQUE("run_id")
);

CREATE TABLE "lba_public_source_state" (
	"source_id" text PRIMARY KEY NOT NULL,
	"last_attempt_at" timestamp with time zone NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure" text
);

CREATE TABLE "lba_production_tools_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" varchar(255) NOT NULL,
	"session_id" varchar(128) NOT NULL,
	"address_id" varchar(255) NOT NULL,
	"binding_fingerprint" char(64) NOT NULL,
	"label" text NOT NULL,
	"locality" text NOT NULL,
	"value" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "lba_production_tools_reports_value_check" CHECK (value = ANY (ARRAY['on'::text, 'off'::text]))
);

CREATE TABLE "lba_account_verified_login" (
	"proof_key" char(64) PRIMARY KEY NOT NULL,
	"owner_id" varchar(255) NOT NULL,
	"session_binding" char(64) NOT NULL,
	"auth_epoch" bigint NOT NULL,
	"link_id" varchar(255) NOT NULL,
	"provider" text NOT NULL,
	"subject_digest" char(64) NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"input_digest" char(64) NOT NULL,
	CONSTRAINT "lba_account_verified_login_check" CHECK (expires_at > verified_at),
	CONSTRAINT "lba_account_verified_login_provider_check" CHECK (provider = ANY (ARRAY['telegram'::text, 'replit'::text]))
);

CREATE TABLE "lba_public_address_candidate" (
	"address_id" text PRIMARY KEY NOT NULL,
	"streets_id" uuid NOT NULL,
	"houses_id" uuid NOT NULL,
	"group_id" uuid NOT NULL
);

CREATE TABLE "lba_owner_auth_epoch" (
	"owner_id" varchar(255) PRIMARY KEY NOT NULL,
	"auth_epoch" bigint NOT NULL,
	CONSTRAINT "lba_owner_auth_epoch_auth_epoch_check" CHECK (auth_epoch >= 1)
);

CREATE TABLE "lba_production_telegram_dispatch_jobs" (
	"operation_id" char(64) PRIMARY KEY NOT NULL,
	"queue_seq" bigserial NOT NULL,
	"bot_id" varchar(32) NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"owner_id" varchar(255),
	"session_id" varchar(128),
	"source_revision" bigint NOT NULL,
	"source_ordinal" integer NOT NULL,
	"control_epoch" bigint NOT NULL,
	"payload_digest" char(64) NOT NULL,
	"payload" jsonb NOT NULL,
	"recipient_ref" varchar(160) NOT NULL,
	"chat_key" char(64),
	"mapping_revision" varchar(160),
	"state" text DEFAULT 'pending' NOT NULL,
	"fence" bigint DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"not_before" timestamp with time zone,
	"provider_receipt" varchar(128),
	"last_reason" varchar(100),
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"recipient_kind" text DEFAULT 'account' NOT NULL,
	CONSTRAINT "lba_production_telegram_dispat_bot_id_source_kind_source_id_key" UNIQUE("bot_id","source_kind","source_id"),
	CONSTRAINT "lba_production_telegram_dispatch_jobs_queue_seq_key" UNIQUE("queue_seq"),
	CONSTRAINT "lba_dispatch_recipient_subject" CHECK (((recipient_kind = 'account'::text) AND (owner_id IS NOT NULL) AND (session_id IS NOT NULL)) OR ((recipient_kind = 'legacy_subscription'::text) AND (source_kind = 'campaign'::text) AND (owner_id IS NULL) AND (session_id IS NULL) AND ((recipient_ref)::text ~~ 'legacy:%'::text))),
	CONSTRAINT "lba_production_telegram_dispatch_jobs_source_kind_check" CHECK (source_kind = ANY (ARRAY['profile'::text, 'campaign'::text])),
	CONSTRAINT "lba_production_telegram_dispatch_jobs_state_check" CHECK (state = ANY (ARRAY['pending'::text, 'prepared'::text, 'dispatching'::text, 'retry_wait'::text, 'sent'::text, 'cancelled'::text, 'not_sent'::text, 'unknown'::text, 'held'::text]))
);

CREATE TABLE "lba_production_schedule_certificate" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" varchar(255) NOT NULL,
	"session_id" varchar(128) NOT NULL,
	"control_epoch" bigint NOT NULL,
	"address_id" text NOT NULL,
	"schedule_revision_id" text NOT NULL,
	"source_revision" char(64) NOT NULL,
	"binding_revision_id" text NOT NULL,
	"view_digest" char(64) NOT NULL,
	"record_digest" char(64) NOT NULL,
	"record" jsonb NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "lba_production_schedule_certificate_check" CHECK (expires_at > issued_at),
	CONSTRAINT "lba_production_schedule_certificate_control_epoch_check" CHECK (control_epoch > 0)
);

CREATE TABLE "lba_release_campaign_jobs" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"release_id" text NOT NULL,
	"recipient_ref" text NOT NULL,
	"cohort" text NOT NULL,
	"record" jsonb NOT NULL,
	CONSTRAINT "lba_release_campaign_jobs_release_id_recipient_ref_key" UNIQUE("release_id","recipient_ref"),
	CONSTRAINT "lba_release_campaign_jobs_cohort_check" CHECK (cohort = ANY (ARRAY['pilot'::text, 'full'::text]))
);

CREATE TABLE "lba_production_profiles" (
	"owner_id" varchar(255) PRIMARY KEY NOT NULL,
	"session_id" varchar(128) NOT NULL,
	"revision" bigint NOT NULL,
	"control_epoch" bigint NOT NULL,
	"state" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "lba_production_profiles_session_id_key" UNIQUE("session_id"),
	CONSTRAINT "lba_production_profiles_revision_check" CHECK ((revision >= 0) AND (revision <= '9007199254740991'::bigint))
);

CREATE TABLE "lba_production_tools_shares" (
	"token" char(48) PRIMARY KEY NOT NULL,
	"owner_id" varchar(255) NOT NULL,
	"session_id" varchar(128) NOT NULL,
	"service_date" date NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"private_scope" jsonb NOT NULL,
	"public_snapshot" jsonb NOT NULL,
	CONSTRAINT "lba_production_tools_shares_check" CHECK (expires_at > created_at)
);

CREATE TABLE "lba_release_campaigns" (
	"release_id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"spec_hash" text NOT NULL,
	"record" jsonb NOT NULL
);

CREATE TABLE "lba_public_address_capture" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operation" text NOT NULL,
	"request_url" text NOT NULL,
	"capture" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"control_epoch" bigint NOT NULL,
	CONSTRAINT "lba_public_address_capture_operation_check" CHECK (operation = ANY (ARRAY['streets'::text, 'houses'::text, 'group'::text])),
	CONSTRAINT "lba_public_address_capture_request_url_check" CHECK (length(request_url) <= 2048)
);

CREATE TABLE "lba_production_schedule_outbox_proof" (
	"outbox_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" varchar(255) NOT NULL,
	"session_id" varchar(128) NOT NULL,
	"event_id" varchar(128) NOT NULL,
	"control_epoch" bigint NOT NULL,
	"certificate_id" uuid NOT NULL,
	"payload_digest" char(64) NOT NULL,
	"view_digest" char(64) NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL
);

CREATE TABLE "lba_production_profile_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" varchar(255) NOT NULL,
	"input_id" varchar(160) NOT NULL,
	"session_id" varchar(128) NOT NULL,
	"revision" bigint NOT NULL,
	"control_epoch" bigint NOT NULL,
	"ordinal" integer NOT NULL,
	"address_id" text,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "lba_production_profile_outbox_owner_id_input_id_ordinal_key" UNIQUE("owner_id","input_id","ordinal"),
	CONSTRAINT "lba_production_profile_outbox_kind_check" CHECK (kind = ANY (ARRAY['reply'::text, 'schedule'::text, 'notification'::text, 'error'::text])),
	CONSTRAINT "lba_production_profile_outbox_ordinal_check" CHECK (ordinal >= 0),
	CONSTRAINT "lba_production_profile_outbox_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'dispatching'::text, 'sent'::text, 'unknown'::text, 'cancelled'::text, 'not_sent'::text]))
);

CREATE TABLE "lba_account_detached_identity" (
	"provider" text NOT NULL,
	"subject_digest" char(64) NOT NULL,
	"former_owner_id" varchar(255) NOT NULL,
	"auth_epoch" bigint NOT NULL,
	"detached_at" timestamp with time zone NOT NULL,
	CONSTRAINT "lba_account_detached_identity_pkey" PRIMARY KEY("provider","subject_digest"),
	CONSTRAINT "lba_account_detached_identity_provider_check" CHECK (provider = ANY (ARRAY['telegram'::text, 'replit'::text]))
);

CREATE TABLE "lba_public_address_query" (
	"request_key" char(64) PRIMARY KEY NOT NULL,
	"request_url" text NOT NULL,
	"last_attempt_at" timestamp with time zone NOT NULL,
	"last_failure" text,
	"latest_capture_id" uuid,
	CONSTRAINT "lba_public_address_query_request_url_check" CHECK (length(request_url) <= 2048)
);

CREATE TABLE "lba_production_telegram_bot_state" (
	"bot_id" varchar(32) PRIMARY KEY NOT NULL,
	"hold_reason" text,
	"hold_operation" char(64),
	"cooldown_until" timestamp with time zone,
	"next_send_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);

CREATE TABLE "lba_production_bootstrap_ledger" (
	"owner_id" varchar(255) PRIMARY KEY NOT NULL,
	"session_id" varchar(128) NOT NULL,
	"source_digest" char(64) NOT NULL,
	"origin_kind" text NOT NULL,
	"initialized_at" timestamp with time zone NOT NULL,
	"control_epoch" bigint NOT NULL,
	CONSTRAINT "lba_production_bootstrap_ledger_session_id_key" UNIQUE("session_id"),
	CONSTRAINT "lba_production_bootstrap_ledger_origin_kind_check" CHECK (origin_kind = ANY (ARRAY['legacy'::text, 'verified_empty'::text]))
);

CREATE TABLE "lba_production_morning_briefing_outbox_proof" (
	"outbox_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" varchar(255) NOT NULL,
	"session_id" varchar(128) NOT NULL,
	"service_date" date NOT NULL,
	"control_epoch" bigint NOT NULL,
	"briefing_id" varchar(128) NOT NULL,
	"packet_digest" char(64) NOT NULL,
	"payload_digest" char(64) NOT NULL,
	"part_index" integer NOT NULL,
	"total_parts" integer NOT NULL
);

CREATE TABLE "lba_production_telegram_processor_scan" (
	"bot_id" varchar(32) NOT NULL,
	"control_epoch" bigint NOT NULL,
	"after_update_id" bigint NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "lba_production_telegram_processor_scan_pkey" PRIMARY KEY("bot_id","control_epoch"),
	CONSTRAINT "lba_production_telegram_processor_scan_after_update_id_check" CHECK ((after_update_id >= 0) AND (after_update_id <= '4503599627370495'::bigint)),
	CONSTRAINT "lba_production_telegram_processor_scan_control_epoch_check" CHECK (control_epoch > 0)
);

CREATE TABLE "lba_public_source_plan" (
	"source_id" text NOT NULL,
	"target_id" text NOT NULL,
	"service_date" date NOT NULL,
	"raw_id" uuid NOT NULL,
	CONSTRAINT "lba_public_source_plan_pkey" PRIMARY KEY("source_id","target_id","service_date")
);

CREATE TABLE "lba_production_address_lookup" (
	"owner_id" varchar(255) NOT NULL,
	"session_id" varchar(128) NOT NULL,
	"operation_id" varchar(96) NOT NULL,
	"input_digest" char(64) NOT NULL,
	"generation" bigint NOT NULL,
	"state" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "lba_production_address_lookup_pkey" PRIMARY KEY("owner_id","session_id")
);

CREATE TABLE "lba_production_address_lookup_requests" (
	"owner_id" varchar(255) NOT NULL,
	"session_id" varchar(128) NOT NULL,
	"operation_id" varchar(96) NOT NULL,
	"input_digest" char(64) NOT NULL,
	"result" jsonb,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "lba_production_address_lookup_requests_pkey" PRIMARY KEY("owner_id","session_id","operation_id")
);

CREATE TABLE "lba_production_event_producer_lease" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"control_epoch" bigint NOT NULL,
	"worker_id" varchar(128) NOT NULL,
	"lease_token" uuid NOT NULL,
	"fence" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"cursor_owner" text DEFAULT '' NOT NULL,
	"cursor_session" text DEFAULT '' NOT NULL,
	"cursor_address" text DEFAULT '' NOT NULL,
	"cursor_day" text DEFAULT '' NOT NULL,
	"cursor_briefing_owner" text DEFAULT '' NOT NULL,
	"cursor_briefing_session" text DEFAULT '' NOT NULL,
	CONSTRAINT "lba_production_event_producer_lease_control_epoch_check" CHECK (control_epoch > 0),
	CONSTRAINT "lba_production_event_producer_lease_fence_check" CHECK (fence > 0),
	CONSTRAINT "lba_production_event_producer_lease_id_check" CHECK (id = true)
);

CREATE TABLE "lba_production_telegram_chat_state" (
	"bot_id" varchar(32) NOT NULL,
	"chat_key" char(64) NOT NULL,
	"owner_id" varchar(255),
	"reachability" text DEFAULT 'unknown' NOT NULL,
	"next_send_at" timestamp with time zone,
	"last_dispatch_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	"recipient_kind" text DEFAULT 'account' NOT NULL,
	CONSTRAINT "lba_production_telegram_chat_state_pkey" PRIMARY KEY("bot_id","chat_key"),
	CONSTRAINT "lba_chat_recipient_subject" CHECK (((recipient_kind = 'account'::text) AND (owner_id IS NOT NULL)) OR ((recipient_kind = 'legacy_subscription'::text) AND (owner_id IS NULL))),
	CONSTRAINT "lba_production_telegram_chat_state_reachability_check" CHECK (reachability = ANY (ARRAY['unknown'::text, 'reachable'::text, 'forbidden'::text]))
);

CREATE TABLE "lba_release_campaign_attempts" (
	"operation_id" text NOT NULL,
	"fence" integer NOT NULL,
	"release_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"spec_hash" text NOT NULL,
	"events" jsonb NOT NULL,
	CONSTRAINT "lba_release_campaign_attempts_pkey" PRIMARY KEY("operation_id","fence")
);

CREATE TABLE "lba_production_morning_briefing_view_proof" (
	"owner_id" varchar(255) NOT NULL,
	"session_id" varchar(128) NOT NULL,
	"service_date" date NOT NULL,
	"address_id" text NOT NULL,
	"control_epoch" bigint NOT NULL,
	"certificate_id" uuid NOT NULL,
	"certificate_digest" char(64) NOT NULL,
	"view_digest" char(64) NOT NULL,
	CONSTRAINT "lba_production_morning_briefing_view_proof_pkey" PRIMARY KEY("owner_id","session_id","service_date","address_id")
);

CREATE TABLE "lba_production_telegram_inbox" (
	"bot_id" varchar(32) NOT NULL,
	"update_id" bigint NOT NULL,
	"payload_sha256" char(64) NOT NULL,
	"control_epoch" bigint NOT NULL,
	"disposition" text NOT NULL,
	"event_kind" text NOT NULL,
	"ignored_reason" text,
	"private_input" jsonb,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "lba_production_telegram_inbox_pkey" PRIMARY KEY("bot_id","update_id"),
	CONSTRAINT "lba_production_telegram_inbox_check" CHECK (((disposition = 'accepted'::text) AND (event_kind = ANY (ARRAY['message'::text, 'callback'::text])) AND (private_input IS NOT NULL) AND (ignored_reason IS NULL)) OR ((disposition = 'ignored'::text) AND (event_kind = 'ignored'::text) AND (private_input IS NULL) AND (ignored_reason IS NOT NULL))),
	CONSTRAINT "lba_production_telegram_inbox_control_epoch_check" CHECK ((control_epoch > 0) AND (control_epoch <= '9007199254740991'::bigint)),
	CONSTRAINT "lba_production_telegram_inbox_disposition_check" CHECK (disposition = ANY (ARRAY['accepted'::text, 'ignored'::text])),
	CONSTRAINT "lba_production_telegram_inbox_event_kind_check" CHECK (event_kind = ANY (ARRAY['message'::text, 'callback'::text, 'ignored'::text])),
	CONSTRAINT "lba_production_telegram_inbox_update_id_check" CHECK ((update_id > 0) AND (update_id <= '4503599627370495'::bigint))
);

CREATE TABLE "lba_production_telegram_callback_ack_attempts" (
	"bot_id" varchar(32) NOT NULL,
	"update_id" bigint NOT NULL,
	"fence" bigint NOT NULL,
	"state" text NOT NULL,
	"prepared_at" timestamp with time zone NOT NULL,
	"dispatch_marked_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"outcome" jsonb,
	"receipt" jsonb,
	CONSTRAINT "lba_production_telegram_callback_ack_attempts_pkey" PRIMARY KEY("bot_id","update_id","fence"),
	CONSTRAINT "lba_production_telegram_callback_ack_attempts_state_check" CHECK (state = ANY (ARRAY['prepared'::text, 'dispatching'::text, 'not_dispatched'::text, 'answered'::text, 'rate_limited'::text, 'not_sent'::text, 'unknown'::text]))
);

CREATE TABLE "lba_public_source_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"control_epoch" bigint NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"code" text,
	CONSTRAINT "lba_public_source_run_control_epoch_check" CHECK (control_epoch > 0),
	CONSTRAINT "lba_public_source_run_status_check" CHECK (status = ANY (ARRAY['started'::text, 'published'::text, 'rejected'::text]))
);

CREATE TABLE "lba_production_telegram_callback_acks" (
	"bot_id" varchar(32) NOT NULL,
	"update_id" bigint NOT NULL,
	"control_epoch" bigint NOT NULL,
	"operation_id" char(64) NOT NULL,
	"ingress_sha256" char(64) NOT NULL,
	"input_sha256" char(64) NOT NULL,
	"state" text NOT NULL,
	"fence" bigint DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"not_before" timestamp with time zone,
	"outcome" jsonb,
	"receipt" jsonb,
	"last_reason" varchar(100),
	"received_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "lba_production_telegram_callback_acks_pkey" PRIMARY KEY("bot_id","update_id"),
	CONSTRAINT "lba_production_telegram_callback_acks_operation_id_key" UNIQUE("operation_id"),
	CONSTRAINT "lba_production_telegram_callback_acks_state_check" CHECK (state = ANY (ARRAY['pending'::text, 'prepared'::text, 'dispatching'::text, 'retry_wait'::text, 'answered'::text, 'not_sent'::text, 'unknown'::text]))
);

CREATE TABLE "lba_account_operation" (
	"owner_id" varchar(255) NOT NULL,
	"operation_id" text NOT NULL,
	"input_digest" char(64) NOT NULL,
	"session_binding" char(64) NOT NULL,
	"auth_epoch" bigint NOT NULL,
	"kind" text NOT NULL,
	"result" jsonb NOT NULL,
	"committed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "lba_account_operation_pkey" PRIMARY KEY("owner_id","operation_id"),
	CONSTRAINT "lba_account_operation_kind_check" CHECK (kind = ANY (ARRAY['challenge'::text, 'link'::text, 'unlink'::text]))
);

CREATE TABLE "lba_production_telegram_processing" (
	"bot_id" varchar(32) NOT NULL,
	"update_id" bigint NOT NULL,
	"chat_key" varchar(96) NOT NULL,
	"control_epoch" bigint NOT NULL,
	"ingress_sha256" char(64) NOT NULL,
	"input_sha256" char(64) NOT NULL,
	"status" text NOT NULL,
	"lease_token" uuid,
	"generation" bigint NOT NULL,
	"lease_until" timestamp with time zone,
	"attempts" integer NOT NULL,
	"bound_owner_id" varchar(255),
	"identity_revision" char(64),
	"dispatch_started_at" timestamp with time zone,
	"last_error" text,
	"canonical_receipt" jsonb,
	"receipt" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "lba_production_telegram_processing_pkey" PRIMARY KEY("bot_id","update_id"),
	CONSTRAINT "lba_production_telegram_processing_attempts_check" CHECK (attempts > 0),
	CONSTRAINT "lba_production_telegram_processing_check" CHECK (((bound_owner_id IS NULL) AND (identity_revision IS NULL)) OR ((bound_owner_id IS NOT NULL) AND (identity_revision IS NOT NULL))),
	CONSTRAINT "lba_production_telegram_processing_check1" CHECK (((status = 'processed'::text) AND (canonical_receipt IS NOT NULL) AND (receipt IS NOT NULL) AND (lease_token IS NULL) AND (lease_until IS NULL)) OR ((status = 'held'::text) AND (receipt IS NULL) AND (lease_token IS NULL) AND (lease_until IS NULL)) OR ((status = ANY (ARRAY['leased'::text, 'dispatching'::text, 'uncertain'::text])) AND (lease_token IS NOT NULL) AND (lease_until IS NOT NULL) AND (receipt IS NULL))),
	CONSTRAINT "lba_production_telegram_processing_generation_check" CHECK ((generation > 0) AND (generation <= '9007199254740991'::bigint)),
	CONSTRAINT "lba_production_telegram_processing_status_check" CHECK (status = ANY (ARRAY['leased'::text, 'dispatching'::text, 'uncertain'::text, 'held'::text, 'processed'::text]))
);

CREATE TABLE "lba_production_profile_inbox" (
	"owner_id" varchar(255) NOT NULL,
	"input_id" varchar(160) NOT NULL,
	"input_digest" char(64) NOT NULL,
	"receipt" jsonb NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "lba_production_profile_inbox_pkey" PRIMARY KEY("owner_id","input_id")
);

CREATE TABLE "lba_production_tools_inbox" (
	"owner_id" varchar(255) NOT NULL,
	"input_id" varchar(102) NOT NULL,
	"session_id" varchar(128) NOT NULL,
	"input_digest" char(64) NOT NULL,
	"receipt" jsonb NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "lba_production_tools_inbox_pkey" PRIMARY KEY("owner_id","input_id")
);

CREATE TABLE "lba_production_schedule_cursor" (
	"owner_id" varchar(255) NOT NULL,
	"session_id" varchar(128) NOT NULL,
	"scope_hash" char(64) NOT NULL,
	"control_epoch" bigint NOT NULL,
	"semantics" text NOT NULL,
	"revision_id" text NOT NULL,
	"event_id" varchar(128) NOT NULL,
	"certificate_id" uuid NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "lba_production_schedule_cursor_pkey" PRIMARY KEY("owner_id","session_id","scope_hash")
);

CREATE TABLE "lba_legacy_campaign_recipient" (
	"recipient_ref" varchar(43) PRIMARY KEY NOT NULL,
	"bot_id" varchar(32) NOT NULL,
	"chat_id" varchar(50) NOT NULL,
	"control_epoch" bigint NOT NULL,
	"subscriber_digest" char(64) NOT NULL,
	"binding_revision" char(64) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "lba_legacy_campaign_recipient_bot_id_chat_id_key" UNIQUE("bot_id","chat_id"),
	CONSTRAINT "lba_legacy_campaign_recipient_control_epoch_check" CHECK ((control_epoch > 0) AND (control_epoch <= '9007199254740991'::bigint)),
	CONSTRAINT "lba_legacy_campaign_recipient_recipient_ref_check" CHECK ((recipient_ref)::text ~ '^legacy:[a-f0-9]{8}-([a-f0-9]{4}-){3}[a-f0-9]{12}$'::text)
);

CREATE TABLE "lba_production_schedule_event" (
	"owner_id" varchar(255) NOT NULL,
	"session_id" varchar(128) NOT NULL,
	"event_id" varchar(128) NOT NULL,
	"control_epoch" bigint NOT NULL,
	"input_digest" char(64) NOT NULL,
	"event" jsonb NOT NULL,
	"view" jsonb NOT NULL,
	"view_digest" char(64) NOT NULL,
	"semantics" text NOT NULL,
	"certificate_id" uuid,
	"receipt" jsonb NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "lba_production_schedule_event_pkey" PRIMARY KEY("owner_id","session_id","event_id"),
	CONSTRAINT "lba_production_schedule_event_owner_id_event_id_key" UNIQUE("owner_id","event_id")
);

CREATE TABLE "lba_production_morning_briefing" (
	"owner_id" varchar(255) NOT NULL,
	"session_id" varchar(128) NOT NULL,
	"service_date" date NOT NULL,
	"control_epoch" bigint NOT NULL,
	"briefing_id" varchar(128) NOT NULL,
	"packet_digest" char(64) NOT NULL,
	"packet" jsonb NOT NULL,
	"receipt" jsonb NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "lba_production_morning_briefing_pkey" PRIMARY KEY("owner_id","session_id","service_date"),
	CONSTRAINT "lba_production_morning_briefing_owner_id_briefing_id_key" UNIQUE("owner_id","briefing_id")
);

CREATE TABLE "lba_telegram_browser_challenge" (
	"challenge_key" text PRIMARY KEY NOT NULL,
	"session_binding" text NOT NULL,
	"origin" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "lba_production_telegram_dispatch_attempts" (
	"operation_id" char(64) NOT NULL,
	"fence" bigint NOT NULL,
	"worker_id" varchar(128) NOT NULL,
	"control_epoch" bigint NOT NULL,
	"state" text NOT NULL,
	"prepared_at" timestamp with time zone NOT NULL,
	"dispatch_marked_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"outcome" jsonb,
	"receipt" jsonb,
	CONSTRAINT "lba_production_telegram_dispatch_attempts_pkey" PRIMARY KEY("operation_id","fence"),
	CONSTRAINT "lba_production_telegram_dispatch_attempts_state_check" CHECK (state = ANY (ARRAY['prepared'::text, 'dispatching'::text, 'not_dispatched'::text, 'sent'::text, 'rate_limited'::text, 'not_sent'::text, 'unknown'::text, 'cancelled'::text]))
);

CREATE TABLE "lba_production_schedule_reminder" (
	"owner_id" varchar(255) NOT NULL,
	"session_id" varchar(128) NOT NULL,
	"occurrence_hash" char(64) NOT NULL,
	"control_epoch" bigint NOT NULL,
	"event_id" varchar(128) NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "lba_production_schedule_reminder_pkey" PRIMARY KEY("owner_id","session_id","occurrence_hash")
);

ALTER TABLE "lba_account_widget_proof_receipt" ADD CONSTRAINT "lba_account_widget_proof_receipt_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "public"."lba_account_link_challenge"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_account_widget_proof_receipt" ADD CONSTRAINT "lba_account_widget_proof_receipt_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_account_link_challenge" ADD CONSTRAINT "lba_account_link_challenge_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_production_profile_origins" ADD CONSTRAINT "lba_production_profile_origins_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."lba_production_profiles"("owner_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_public_source_raw" ADD CONSTRAINT "lba_public_source_raw_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."lba_public_source_run"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_production_tools_reports" ADD CONSTRAINT "lba_production_tools_reports_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."lba_production_profiles"("owner_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_account_verified_login" ADD CONSTRAINT "lba_account_verified_login_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_public_address_candidate" ADD CONSTRAINT "lba_public_address_candidate_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."lba_public_address_capture"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_public_address_candidate" ADD CONSTRAINT "lba_public_address_candidate_houses_id_fkey" FOREIGN KEY ("houses_id") REFERENCES "public"."lba_public_address_capture"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_public_address_candidate" ADD CONSTRAINT "lba_public_address_candidate_streets_id_fkey" FOREIGN KEY ("streets_id") REFERENCES "public"."lba_public_address_capture"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_owner_auth_epoch" ADD CONSTRAINT "lba_owner_auth_epoch_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_production_schedule_certificate" ADD CONSTRAINT "lba_production_schedule_certificate_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."lba_production_profiles"("owner_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_release_campaign_jobs" ADD CONSTRAINT "lba_release_campaign_jobs_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "public"."lba_release_campaigns"("release_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_production_tools_shares" ADD CONSTRAINT "lba_production_tools_shares_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."lba_production_profiles"("owner_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_production_schedule_outbox_proof" ADD CONSTRAINT "lba_production_schedule_outbo_owner_id_session_id_event_id_fkey" FOREIGN KEY ("owner_id","session_id","event_id") REFERENCES "public"."lba_production_schedule_event"("owner_id","session_id","event_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_production_schedule_outbox_proof" ADD CONSTRAINT "lba_production_schedule_outbox_proof_certificate_id_fkey" FOREIGN KEY ("certificate_id") REFERENCES "public"."lba_production_schedule_certificate"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_production_schedule_outbox_proof" ADD CONSTRAINT "lba_production_schedule_outbox_proof_outbox_id_fkey" FOREIGN KEY ("outbox_id") REFERENCES "public"."lba_production_profile_outbox"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_production_profile_outbox" ADD CONSTRAINT "lba_production_profile_outbox_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."lba_production_profiles"("owner_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_account_detached_identity" ADD CONSTRAINT "lba_account_detached_identity_former_owner_id_fkey" FOREIGN KEY ("former_owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_public_address_query" ADD CONSTRAINT "lba_public_address_query_latest_capture_id_fkey" FOREIGN KEY ("latest_capture_id") REFERENCES "public"."lba_public_address_capture"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_production_morning_briefing_outbox_proof" ADD CONSTRAINT "lba_production_morning_brief_owner_id_session_id_service__fkey1" FOREIGN KEY ("owner_id","session_id","service_date") REFERENCES "public"."lba_production_morning_briefing"("owner_id","session_id","service_date") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_production_morning_briefing_outbox_proof" ADD CONSTRAINT "lba_production_morning_briefing_outbox_proof_outbox_id_fkey" FOREIGN KEY ("outbox_id") REFERENCES "public"."lba_production_profile_outbox"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_public_source_plan" ADD CONSTRAINT "lba_public_source_plan_raw_id_fkey" FOREIGN KEY ("raw_id") REFERENCES "public"."lba_public_source_raw"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_production_address_lookup" ADD CONSTRAINT "lba_production_address_lookup_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."lba_production_profiles"("owner_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_production_address_lookup_requests" ADD CONSTRAINT "lba_production_address_lookup_requests_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."lba_production_profiles"("owner_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_release_campaign_attempts" ADD CONSTRAINT "lba_release_campaign_attempts_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "public"."lba_release_campaign_jobs"("operation_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_release_campaign_attempts" ADD CONSTRAINT "lba_release_campaign_attempts_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "public"."lba_release_campaigns"("release_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_production_morning_briefing_view_proof" ADD CONSTRAINT "lba_production_morning_briefi_owner_id_session_id_service__fkey" FOREIGN KEY ("owner_id","session_id","service_date") REFERENCES "public"."lba_production_morning_briefing"("owner_id","session_id","service_date") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_production_morning_briefing_view_proof" ADD CONSTRAINT "lba_production_morning_briefing_view_proof_certificate_id_fkey" FOREIGN KEY ("certificate_id") REFERENCES "public"."lba_production_schedule_certificate"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_production_telegram_callback_ack_attempts" ADD CONSTRAINT "lba_production_telegram_callback_ack_atte_bot_id_update_id_fkey" FOREIGN KEY ("bot_id","update_id") REFERENCES "public"."lba_production_telegram_callback_acks"("bot_id","update_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_production_telegram_callback_acks" ADD CONSTRAINT "lba_production_telegram_callback_acks_bot_id_update_id_fkey" FOREIGN KEY ("bot_id","update_id") REFERENCES "public"."lba_production_telegram_inbox"("bot_id","update_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_account_operation" ADD CONSTRAINT "lba_account_operation_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_production_telegram_processing" ADD CONSTRAINT "lba_production_telegram_processing_bot_id_update_id_fkey" FOREIGN KEY ("bot_id","update_id") REFERENCES "public"."lba_production_telegram_inbox"("bot_id","update_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_production_profile_inbox" ADD CONSTRAINT "lba_production_profile_inbox_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."lba_production_profiles"("owner_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_production_tools_inbox" ADD CONSTRAINT "lba_production_tools_inbox_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."lba_production_profiles"("owner_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_production_schedule_cursor" ADD CONSTRAINT "lba_production_schedule_cursor_certificate_id_fkey" FOREIGN KEY ("certificate_id") REFERENCES "public"."lba_production_schedule_certificate"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_production_schedule_cursor" ADD CONSTRAINT "lba_production_schedule_cursor_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."lba_production_profiles"("owner_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_production_schedule_event" ADD CONSTRAINT "lba_production_schedule_event_certificate_id_fkey" FOREIGN KEY ("certificate_id") REFERENCES "public"."lba_production_schedule_certificate"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_production_schedule_event" ADD CONSTRAINT "lba_production_schedule_event_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."lba_production_profiles"("owner_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_production_morning_briefing" ADD CONSTRAINT "lba_production_morning_briefing_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."lba_production_profiles"("owner_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_production_telegram_dispatch_attempts" ADD CONSTRAINT "lba_production_telegram_dispatch_attempts_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "public"."lba_production_telegram_dispatch_jobs"("operation_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "lba_production_schedule_reminder" ADD CONSTRAINT "lba_production_schedule_reminder_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."lba_production_profiles"("owner_id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "lba_production_tools_reports_owner_time" ON "lba_production_tools_reports" USING btree ("owner_id","recorded_at","id");
CREATE INDEX "lba_production_telegram_dispatch_head" ON "lba_production_telegram_dispatch_jobs" USING btree ("bot_id","owner_id","queue_seq") WHERE (state = ANY (ARRAY['pending'::text, 'prepared'::text, 'dispatching'::text, 'retry_wait'::text, 'unknown'::text, 'held'::text]));
CREATE INDEX "lba_production_schedule_certificate_view" ON "lba_production_schedule_certificate" USING btree ("owner_id","session_id","address_id","view_digest") WHERE (revoked_at IS NULL);
CREATE INDEX "lba_release_campaign_job_release" ON "lba_release_campaign_jobs" USING btree ("release_id","cohort");
CREATE INDEX "lba_release_campaign_job_state" ON "lba_release_campaign_jobs" USING btree (((record ->> 'state'::text)));
CREATE INDEX "lba_production_tools_shares_owner" ON "lba_production_tools_shares" USING btree ("owner_id","created_at","token");
CREATE INDEX "lba_release_campaign_bot" ON "lba_release_campaigns" USING btree ("bot_id");
CREATE INDEX "lba_public_address_capture_observed" ON "lba_public_address_capture" USING btree ("observed_at");
CREATE INDEX "lba_production_profile_outbox_pending" ON "lba_production_profile_outbox" USING btree ("owner_id","session_id","control_epoch","revision","ordinal","id") WHERE (status = 'pending'::text);
CREATE INDEX "lba_public_source_plan_raw" ON "lba_public_source_plan" USING btree ("raw_id");
CREATE INDEX "lba_production_telegram_inbox_received" ON "lba_production_telegram_inbox" USING btree ("bot_id","control_epoch","received_at","update_id") WHERE (disposition = 'accepted'::text);
CREATE INDEX "lba_production_telegram_callback_ack_pending" ON "lba_production_telegram_callback_acks" USING btree ("bot_id","control_epoch","update_id") WHERE (state = ANY (ARRAY['pending'::text, 'prepared'::text, 'dispatching'::text, 'retry_wait'::text, 'unknown'::text]));
CREATE INDEX "lba_production_telegram_processing_chat" ON "lba_production_telegram_processing" USING btree ("bot_id","chat_key","control_epoch","update_id");
CREATE INDEX "lba_telegram_browser_challenge_expiry" ON "lba_telegram_browser_challenge" USING btree ("expires_at");