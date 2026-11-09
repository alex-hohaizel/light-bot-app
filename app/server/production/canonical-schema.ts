import {createHash} from 'node:crypto';
import {AUTH_REPLAY_SCHEMA_SQL} from './auth-replay.ts';
import {PRODUCTION_PROFILE_SCHEMA_SQL} from './profile-store.ts';
import {SOURCE_INGESTION_SCHEMA_SQL} from './source-ingestion.ts';
import {ADDRESS_CATALOG_SCHEMA_SQL} from './address-catalog.ts';
import {OWNED_ADDRESS_LOOKUP_SCHEMA_SQL} from './address-flow.ts';
import {PRODUCTION_TOOLS_SCHEMA_SQL} from './product-tools.ts';
import {TELEGRAM_INBOX_SCHEMA_SQL} from './telegram-inbox.ts';
import {TELEGRAM_PROCESSOR_SCHEMA_SQL} from './telegram-processor.ts';
import {TELEGRAM_DISPATCH_SCHEMA_SQL,TELEGRAM_CALLBACK_ACK_SCHEMA_SQL} from './telegram-dispatch.ts';
import {UPDATE_CAMPAIGN_SCHEMA_SQL} from '../release/update-campaign-pg.ts';
import {ACCOUNT_LINKS_SCHEMA_SQL} from './account-links.ts';
import {SCHEDULE_EVENTS_SCHEMA_SQL} from './schedule-events.ts';
import {BROWSER_TELEGRAM_AUTH_SCHEMA_SQL} from './telegram-browser-auth.ts';
import {MORNING_BRIEFING_SCHEMA_SQL} from './morning-briefing.ts';
import {EVENT_PRODUCER_SCHEMA_SQL} from './event-producer.ts';
import {LEGACY_CAMPAIGN_RECIPIENT_SCHEMA_SQL} from './legacy-campaign-recipient.ts';

/** A reviewable future migration bundle, never executed by import or startup.
 * Required relations derive from the same explicit DDL as the local rehearsal. */
export const CANONICAL_SCHEMA_SQL=[AUTH_REPLAY_SCHEMA_SQL,PRODUCTION_PROFILE_SCHEMA_SQL,ACCOUNT_LINKS_SCHEMA_SQL,SOURCE_INGESTION_SCHEMA_SQL,
 ADDRESS_CATALOG_SCHEMA_SQL,OWNED_ADDRESS_LOOKUP_SCHEMA_SQL,PRODUCTION_TOOLS_SCHEMA_SQL,TELEGRAM_INBOX_SCHEMA_SQL,
 TELEGRAM_PROCESSOR_SCHEMA_SQL,TELEGRAM_DISPATCH_SCHEMA_SQL,TELEGRAM_CALLBACK_ACK_SCHEMA_SQL,UPDATE_CAMPAIGN_SCHEMA_SQL,SCHEDULE_EVENTS_SCHEMA_SQL,
 BROWSER_TELEGRAM_AUTH_SCHEMA_SQL,MORNING_BRIEFING_SCHEMA_SQL,EVENT_PRODUCER_SCHEMA_SQL,LEGACY_CAMPAIGN_RECIPIENT_SCHEMA_SQL].join('\n');
export const CANONICAL_SCHEMA_SHA256=createHash('sha256').update(CANONICAL_SCHEMA_SQL).digest('hex');
export const CANONICAL_REQUIRED_RELATIONS=Object.freeze([...CANONICAL_SCHEMA_SQL.matchAll(/create table if not exists ([a-z_][a-z0-9_]*)\s*\(/gi)].map(match=>match[1]));
