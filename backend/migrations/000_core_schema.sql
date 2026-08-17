--
-- Core schema — committed dump (audit finding C-02).
--
-- Regenerate with: npm run schema:dump
-- Applied by scripts/baseline-schema.js when provisioning a clean database.
-- Do not hand-edit: write a new migration instead.
--
-- Generated: 2026-08-17T17:02:27.891Z
--
--
-- PostgreSQL database dump
--


-- Dumped from database version 18.2
-- Dumped by pg_dump version 18.2

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS public;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
      $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: ab_experiment_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ab_experiment_events (
    id bigint NOT NULL,
    experiment_key text NOT NULL,
    variant_key text NOT NULL,
    user_id uuid,
    outcome_value numeric,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ab_experiment_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ab_experiment_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ab_experiment_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ab_experiment_events_id_seq OWNED BY public.ab_experiment_events.id;


--
-- Name: ab_experiments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ab_experiments (
    id bigint NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    outcome_metric text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ab_experiments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ab_experiments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ab_experiments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ab_experiments_id_seq OWNED BY public.ab_experiments.id;


--
-- Name: account_id_sequences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_id_sequences (
    category text NOT NULL,
    last_value integer DEFAULT 0 NOT NULL
);


--
-- Name: account_link_clusters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_link_clusters (
    id bigint NOT NULL,
    cluster_key text NOT NULL,
    score integer DEFAULT 0 NOT NULL,
    confidence text DEFAULT 'low'::text NOT NULL,
    member_user_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    member_count integer DEFAULT 0 NOT NULL,
    signal_types text[] DEFAULT '{}'::text[] NOT NULL,
    signal_summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    first_detected_at timestamp with time zone DEFAULT now() NOT NULL,
    last_detected_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by text,
    resolution_note text
);


--
-- Name: account_link_clusters_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.account_link_clusters_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: account_link_clusters_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.account_link_clusters_id_seq OWNED BY public.account_link_clusters.id;


--
-- Name: account_link_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_link_evidence (
    id bigint NOT NULL,
    cluster_id bigint NOT NULL,
    evidence_type text NOT NULL,
    evidence_value text,
    evidence_label text,
    user_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    distinct_users integer DEFAULT 0 NOT NULL,
    weight integer DEFAULT 0 NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    observed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: account_link_evidence_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.account_link_evidence_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: account_link_evidence_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.account_link_evidence_id_seq OWNED BY public.account_link_evidence.id;


--
-- Name: account_promotion_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_promotion_reviews (
    id bigint NOT NULL,
    source_account_id text NOT NULL,
    user_id text NOT NULL,
    from_account_type text NOT NULL,
    target_account_type text NOT NULL,
    account_size numeric,
    status text DEFAULT 'pending'::text NOT NULL,
    triggered_by text,
    reason text,
    requested_by_admin_id text,
    decided_by_admin_id text,
    decision_note text,
    created_account_id text,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    decided_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: account_promotion_reviews_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.account_promotion_reviews_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: account_promotion_reviews_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.account_promotion_reviews_id_seq OWNED BY public.account_promotion_reviews.id;


--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    account_type character varying(20) NOT NULL,
    account_size numeric(15,2) NOT NULL,
    current_balance numeric(15,2) NOT NULL,
    starting_balance numeric(15,2) NOT NULL,
    peak_balance numeric(15,2) NOT NULL,
    profit_target numeric(15,2) NOT NULL,
    max_drawdown_pct numeric(5,2) NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying,
    phase_start_date timestamp without time zone DEFAULT now(),
    phase_end_date timestamp without time zone,
    demo_account_id character varying(100),
    bridge_mode character varying(10),
    flagged boolean DEFAULT false,
    flag_reason character varying(500),
    bot_score integer DEFAULT 0,
    bridge_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now(),
    review_flagged boolean DEFAULT false NOT NULL,
    review_flag_reason text,
    account_uid text,
    updated_at timestamp with time zone,
    challenge_model_id integer,
    challenge_model_slug text,
    step_number integer DEFAULT 1,
    daily_drawdown_pct numeric(5,2),
    drawdown_type text DEFAULT 'eod_trailing'::text,
    eod_trailing_floor numeric(15,2),
    eod_peak_equity numeric(15,2),
    consistency_max_day_pct numeric(5,2),
    min_trading_days integer DEFAULT 5,
    min_daily_profit_pct numeric(5,2) DEFAULT 0.5,
    qualifying_days_count integer DEFAULT 0,
    free_retries_remaining integer DEFAULT 1,
    parent_account_id text,
    scaling_multiplier numeric DEFAULT 1 NOT NULL,
    scaling_milestones_claimed integer DEFAULT 0 NOT NULL,
    CONSTRAINT accounts_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'passed'::character varying, 'failed'::character varying, 'expired'::character varying, 'locked'::character varying, 'cancelled'::character varying, 'closed'::character varying])::text[])))
);


--
-- Name: admin_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_audit_log (
    id bigint NOT NULL,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id text,
    details jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_audit_log_id_seq OWNED BY public.admin_audit_log.id;


--
-- Name: admin_balance_adjustments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_balance_adjustments (
    id integer NOT NULL,
    account_id text NOT NULL,
    amount numeric(15,2) NOT NULL,
    balance_before numeric(15,2) NOT NULL,
    balance_after numeric(15,2) NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id text,
    adjustment_type text DEFAULT 'manual'::text NOT NULL,
    created_by text DEFAULT 'admin'::text NOT NULL
);


--
-- Name: admin_balance_adjustments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_balance_adjustments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_balance_adjustments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_balance_adjustments_id_seq OWNED BY public.admin_balance_adjustments.id;


--
-- Name: admin_cases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_cases (
    id bigint NOT NULL,
    source_type text DEFAULT 'manual'::text NOT NULL,
    source_id text DEFAULT ''::text NOT NULL,
    title text NOT NULL,
    severity text DEFAULT 'medium'::text NOT NULL,
    priority text DEFAULT 'normal'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    owner text,
    notes text,
    created_by text DEFAULT 'admin'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone
);


--
-- Name: admin_cases_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_cases_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_cases_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_cases_id_seq OWNED BY public.admin_cases.id;


--
-- Name: admin_dispute_meta; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_dispute_meta (
    id bigint NOT NULL,
    dispute_id text NOT NULL,
    owner text,
    priority text DEFAULT 'normal'::text NOT NULL,
    sla_hours integer DEFAULT 48 NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_dispute_meta_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_dispute_meta_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_dispute_meta_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_dispute_meta_id_seq OWNED BY public.admin_dispute_meta.id;


--
-- Name: admin_enforcement_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_enforcement_events (
    id bigint NOT NULL,
    rule_id bigint,
    account_id text,
    user_id text,
    action text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'applied'::text NOT NULL,
    message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_enforcement_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_enforcement_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_enforcement_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_enforcement_events_id_seq OWNED BY public.admin_enforcement_events.id;


--
-- Name: admin_entity_meta; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_entity_meta (
    id bigint NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    owner_admin_id text,
    priority text DEFAULT 'normal'::text NOT NULL,
    workflow_status text DEFAULT 'open'::text NOT NULL,
    classification text,
    risk_tier text DEFAULT 'low'::text NOT NULL,
    status_reason text,
    sla_state text,
    linked_case_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_entity_meta_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_entity_meta_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_entity_meta_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_entity_meta_id_seq OWNED BY public.admin_entity_meta.id;


--
-- Name: admin_entity_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_entity_notes (
    id bigint NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    note_text text NOT NULL,
    created_by text DEFAULT 'admin'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_entity_notes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_entity_notes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_entity_notes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_entity_notes_id_seq OWNED BY public.admin_entity_notes.id;


--
-- Name: admin_entity_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_entity_tags (
    id bigint NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    tag text NOT NULL,
    created_by text DEFAULT 'admin'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_entity_tags_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_entity_tags_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_entity_tags_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_entity_tags_id_seq OWNED BY public.admin_entity_tags.id;


--
-- Name: admin_feature_flags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_feature_flags (
    id bigint NOT NULL,
    flag_key text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    rollout_pct integer DEFAULT 100 NOT NULL,
    segment text DEFAULT 'all'::text NOT NULL,
    updated_by text DEFAULT 'admin'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_feature_flags_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_feature_flags_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_feature_flags_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_feature_flags_id_seq OWNED BY public.admin_feature_flags.id;


--
-- Name: admin_four_eyes_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_four_eyes_requests (
    id bigint NOT NULL,
    action_type text NOT NULL,
    target_type text DEFAULT 'generic'::text NOT NULL,
    target_id text DEFAULT ''::text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    requested_by text DEFAULT 'admin'::text NOT NULL,
    approvals_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    required_approvals integer DEFAULT 2 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone
);


--
-- Name: admin_four_eyes_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_four_eyes_requests_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_four_eyes_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_four_eyes_requests_id_seq OWNED BY public.admin_four_eyes_requests.id;


--
-- Name: admin_immutable_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_immutable_audit (
    id bigint NOT NULL,
    event_type text NOT NULL,
    entity_type text DEFAULT ''::text NOT NULL,
    entity_id text DEFAULT ''::text NOT NULL,
    actor text DEFAULT 'admin'::text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    payload_text text DEFAULT '{}'::text NOT NULL,
    prev_hash text NOT NULL,
    entry_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_immutable_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_immutable_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_immutable_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_immutable_audit_id_seq OWNED BY public.admin_immutable_audit.id;


--
-- Name: admin_incidents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_incidents (
    id bigint NOT NULL,
    title text NOT NULL,
    severity text DEFAULT 'medium'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    source text,
    details text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    acknowledged_at timestamp with time zone,
    resolved_at timestamp with time zone,
    acknowledged_by text
);


--
-- Name: admin_incidents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_incidents_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_incidents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_incidents_id_seq OWNED BY public.admin_incidents.id;


--
-- Name: admin_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_notes (
    id bigint NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    note_text text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_notes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_notes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_notes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_notes_id_seq OWNED BY public.admin_notes.id;


--
-- Name: admin_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_notifications (
    id bigint NOT NULL,
    type text DEFAULT 'info'::text NOT NULL,
    channel text DEFAULT 'web'::text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    message text NOT NULL,
    audience text DEFAULT 'all'::text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    scheduled_for timestamp with time zone,
    sent_at timestamp with time zone,
    created_by text DEFAULT 'admin'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_notifications_id_seq OWNED BY public.admin_notifications.id;


--
-- Name: admin_rule_violations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_rule_violations (
    id bigint NOT NULL,
    violation_key text NOT NULL,
    violation_type text NOT NULL,
    severity text DEFAULT 'medium'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    account_id text,
    user_id text,
    trade_id text,
    instrument text,
    source text DEFAULT 'system'::text NOT NULL,
    message text DEFAULT ''::text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    hit_count integer DEFAULT 1 NOT NULL,
    first_detected_at timestamp with time zone DEFAULT now() NOT NULL,
    last_detected_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolution_note text,
    resolution_type text DEFAULT 'resolved'::text NOT NULL
);


--
-- Name: admin_rule_violations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_rule_violations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_rule_violations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_rule_violations_id_seq OWNED BY public.admin_rule_violations.id;


--
-- Name: admin_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_rules (
    id bigint NOT NULL,
    name text NOT NULL,
    scope text DEFAULT 'global'::text NOT NULL,
    condition_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    action_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    trigger_count integer DEFAULT 0 NOT NULL,
    last_triggered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_rules_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_rules_id_seq OWNED BY public.admin_rules.id;


--
-- Name: admin_saved_views; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_saved_views (
    id bigint NOT NULL,
    admin_id text DEFAULT ''::text NOT NULL,
    admin_role text DEFAULT 'admin'::text NOT NULL,
    resource text NOT NULL,
    name text NOT NULL,
    config_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_saved_views_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_saved_views_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_saved_views_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_saved_views_id_seq OWNED BY public.admin_saved_views.id;


--
-- Name: admin_scheduled_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_scheduled_reports (
    id bigint NOT NULL,
    report_key text NOT NULL,
    title text NOT NULL,
    channel text DEFAULT 'email'::text NOT NULL,
    recipients text DEFAULT ''::text NOT NULL,
    schedule_cron text DEFAULT '0 9 * * *'::text NOT NULL,
    timezone text DEFAULT 'UTC'::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    last_run_at timestamp with time zone,
    next_run_at timestamp with time zone,
    created_by text DEFAULT 'admin'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_scheduled_reports_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_scheduled_reports_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_scheduled_reports_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_scheduled_reports_id_seq OWNED BY public.admin_scheduled_reports.id;


--
-- Name: affiliate_commission_tiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.affiliate_commission_tiers (
    id bigint NOT NULL,
    tier_rank integer NOT NULL,
    label text,
    min_referrals integer NOT NULL,
    commission_pct numeric NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: affiliate_commission_tiers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.affiliate_commission_tiers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: affiliate_commission_tiers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.affiliate_commission_tiers_id_seq OWNED BY public.affiliate_commission_tiers.id;


--
-- Name: affiliate_commissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.affiliate_commissions (
    id bigint NOT NULL,
    referral_id bigint,
    referrer_user_id uuid NOT NULL,
    referred_user_id uuid,
    order_id bigint,
    tier_rank integer,
    commission_rate_pct numeric,
    order_amount numeric,
    commission_amount numeric NOT NULL,
    status text DEFAULT 'available'::text NOT NULL,
    payout_request_id bigint,
    adjustment_note text,
    adjusted_by text,
    adjusted_at timestamp with time zone,
    earned_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT affiliate_commissions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'available'::text, 'paid'::text, 'adjusted'::text])))
);


--
-- Name: affiliate_commissions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.affiliate_commissions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: affiliate_commissions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.affiliate_commissions_id_seq OWNED BY public.affiliate_commissions.id;


--
-- Name: affiliate_payout_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.affiliate_payout_requests (
    id bigint NOT NULL,
    affiliate_user_id uuid NOT NULL,
    amount_requested numeric NOT NULL,
    payment_method text NOT NULL,
    payment_details text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    admin_notes text,
    transaction_id text,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    paid_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT affiliate_payout_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'paid'::text, 'rejected'::text])))
);


--
-- Name: affiliate_payout_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.affiliate_payout_requests_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: affiliate_payout_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.affiliate_payout_requests_id_seq OWNED BY public.affiliate_payout_requests.id;


--
-- Name: affiliate_referrals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.affiliate_referrals (
    id bigint NOT NULL,
    referrer_user_id uuid NOT NULL,
    referred_user_id uuid NOT NULL,
    affiliate_code_used text NOT NULL,
    source text DEFAULT 'registration'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: affiliate_referrals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.affiliate_referrals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: affiliate_referrals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.affiliate_referrals_id_seq OWNED BY public.affiliate_referrals.id;


--
-- Name: announcements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.announcements (
    id integer NOT NULL,
    message text NOT NULL,
    type text DEFAULT 'info'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone
);


--
-- Name: announcements_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.announcements_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: announcements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.announcements_id_seq OWNED BY public.announcements.id;


--
-- Name: balance_adjustments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.balance_adjustments (
    id bigint NOT NULL,
    account_id uuid NOT NULL,
    user_id uuid,
    source text NOT NULL,
    competition_id bigint,
    competition_entry_id bigint,
    amount numeric(15,2) NOT NULL,
    balance_before numeric(15,2) NOT NULL,
    balance_after numeric(15,2) NOT NULL,
    reason text DEFAULT ''::text NOT NULL,
    created_by text DEFAULT 'system'::text NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT balance_adjustments_amount_nonzero_check CHECK ((amount <> (0)::numeric))
);


--
-- Name: balance_adjustments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.balance_adjustments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: balance_adjustments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.balance_adjustments_id_seq OWNED BY public.balance_adjustments.id;


--
-- Name: bbook_pnl; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bbook_pnl (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    date date DEFAULT CURRENT_DATE NOT NULL,
    total_broker_pnl numeric(15,2) DEFAULT 0,
    trades_count integer DEFAULT 0,
    accounts_failed integer DEFAULT 0,
    accounts_passed integer DEFAULT 0,
    accounts_expired integer DEFAULT 0,
    new_funded integer DEFAULT 0
);


--
-- Name: challenge_checkout_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.challenge_checkout_sessions (
    id bigint NOT NULL,
    order_id bigint NOT NULL,
    provider text DEFAULT 'stripe'::text NOT NULL,
    checkout_session_id text NOT NULL,
    checkout_url text,
    provider_customer_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: challenge_checkout_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.challenge_checkout_sessions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: challenge_checkout_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.challenge_checkout_sessions_id_seq OWNED BY public.challenge_checkout_sessions.id;


--
-- Name: challenge_model_pricing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.challenge_model_pricing (
    id integer NOT NULL,
    challenge_model_id integer NOT NULL,
    account_size integer NOT NULL,
    price numeric(10,2) NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_unlimited boolean DEFAULT true NOT NULL,
    slot_limit integer
);


--
-- Name: challenge_model_pricing_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.challenge_model_pricing_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: challenge_model_pricing_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.challenge_model_pricing_id_seq OWNED BY public.challenge_model_pricing.id;


--
-- Name: challenge_models; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.challenge_models (
    id integer NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    description text,
    steps integer DEFAULT 1 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    profit_targets_pct jsonb DEFAULT '[10]'::jsonb NOT NULL,
    daily_drawdown_pct numeric(5,2) DEFAULT 3.0 NOT NULL,
    max_drawdown_pct numeric(5,2) DEFAULT 4.0 NOT NULL,
    drawdown_type text DEFAULT 'eod_trailing'::text NOT NULL,
    drawdown_locks_at_breakeven boolean DEFAULT false NOT NULL,
    funded_max_drawdown_pct numeric(5,2) DEFAULT 4.0 NOT NULL,
    funded_daily_drawdown_pct numeric(5,2) DEFAULT 3.0 NOT NULL,
    time_limits_days jsonb DEFAULT '[30]'::jsonb NOT NULL,
    consistency_rule_enabled boolean DEFAULT true NOT NULL,
    consistency_max_day_pct numeric(5,2) DEFAULT 24.0 NOT NULL,
    min_trading_days integer DEFAULT 5 NOT NULL,
    min_daily_profit_pct numeric(5,2) DEFAULT 0.5 NOT NULL,
    no_martingale boolean DEFAULT true NOT NULL,
    no_grid_trading boolean DEFAULT true NOT NULL,
    no_ea_bots boolean DEFAULT true NOT NULL,
    no_hedging boolean DEFAULT false NOT NULL,
    news_restriction_enabled boolean DEFAULT true NOT NULL,
    news_restriction_minutes integer DEFAULT 5 NOT NULL,
    allow_overnight boolean DEFAULT true NOT NULL,
    allow_weekend_holding boolean DEFAULT true NOT NULL,
    profit_split_pct numeric(5,2) DEFAULT 100.0 NOT NULL,
    scaling_enabled boolean DEFAULT true NOT NULL,
    scaling_target_pct numeric(5,2) DEFAULT 10.0 NOT NULL,
    scaling_multiplier numeric(5,2) DEFAULT 2.0 NOT NULL,
    scaling_max_account_size integer DEFAULT 200000 NOT NULL,
    free_retries integer DEFAULT 1 NOT NULL,
    max_leverage integer DEFAULT 20 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    consistency_max_day_pct_by_phase jsonb,
    funded_drawdown_locks_at_pct numeric,
    funded_min_trading_days_for_payout integer,
    funded_payout_min_net_profit_pct numeric,
    funded_consistency_max_day_pct numeric,
    payout_frequency text,
    scaling_increase_per_milestone_pct numeric
);


--
-- Name: challenge_models_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.challenge_models_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: challenge_models_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.challenge_models_id_seq OWNED BY public.challenge_models.id;


--
-- Name: challenge_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.challenge_orders (
    id bigint NOT NULL,
    user_id text NOT NULL,
    account_size numeric(12,2) NOT NULL,
    amount numeric(12,2) DEFAULT 0 NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    checkout_mode text DEFAULT 'free'::text NOT NULL,
    payment_provider text,
    paid_via text,
    provider_reference text,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    expires_at timestamp with time zone,
    paid_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    challenge_model_id integer,
    challenge_model_slug text,
    is_gift boolean DEFAULT false NOT NULL,
    gift_recipient_email text
);


--
-- Name: challenge_orders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.challenge_orders_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: challenge_orders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.challenge_orders_id_seq OWNED BY public.challenge_orders.id;


--
-- Name: challenge_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.challenge_payments (
    id bigint NOT NULL,
    order_id bigint NOT NULL,
    provider text NOT NULL,
    provider_payment_id text,
    amount numeric(12,2) DEFAULT 0 NOT NULL,
    platform_fee_amount numeric(12,2) DEFAULT 0 NOT NULL,
    tenant_net_amount numeric(12,2) DEFAULT 0 NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: challenge_payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.challenge_payments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: challenge_payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.challenge_payments_id_seq OWNED BY public.challenge_payments.id;


--
-- Name: challenge_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.challenge_products (
    id bigint NOT NULL,
    account_size numeric(12,2) NOT NULL,
    display_name text,
    challenge_fee_amount numeric(12,2) DEFAULT 0 NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: challenge_products_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.challenge_products_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: challenge_products_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.challenge_products_id_seq OWNED BY public.challenge_products.id;


--
-- Name: chat_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_conversations (
    id bigint NOT NULL,
    user_id text NOT NULL,
    subject text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    assigned_to text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_message_at timestamp with time zone,
    unread_user_count integer DEFAULT 0 NOT NULL,
    unread_admin_count integer DEFAULT 0 NOT NULL
);


--
-- Name: chat_conversations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.chat_conversations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: chat_conversations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.chat_conversations_id_seq OWNED BY public.chat_conversations.id;


--
-- Name: chat_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_messages (
    id bigint NOT NULL,
    conversation_id integer NOT NULL,
    user_id text,
    message text NOT NULL,
    is_admin boolean DEFAULT false NOT NULL,
    sender_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone,
    attachments jsonb DEFAULT '[]'::jsonb
);


--
-- Name: chat_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.chat_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: chat_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.chat_messages_id_seq OWNED BY public.chat_messages.id;


--
-- Name: competition_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.competition_entries (
    id bigint NOT NULL,
    competition_id bigint NOT NULL,
    user_id uuid NOT NULL,
    account_id uuid,
    status text DEFAULT 'active'::text NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    final_rank integer,
    final_profit_pct numeric,
    final_profit_usd numeric,
    final_stats_json jsonb,
    disqualified_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: competition_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.competition_entries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: competition_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.competition_entries_id_seq OWNED BY public.competition_entries.id;


--
-- Name: competition_prize_vouchers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.competition_prize_vouchers (
    id bigint NOT NULL,
    code text NOT NULL,
    competition_id bigint NOT NULL,
    competition_entry_id bigint,
    user_id uuid NOT NULL,
    account_size numeric(12,2) NOT NULL,
    challenge_model_slug text NOT NULL,
    status text DEFAULT 'issued'::text NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    redeemed_at timestamp with time zone,
    redeemed_order_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT competition_prize_vouchers_status_check CHECK ((status = ANY (ARRAY['issued'::text, 'redeemed'::text, 'expired'::text, 'revoked'::text])))
);


--
-- Name: competition_prize_vouchers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.competition_prize_vouchers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: competition_prize_vouchers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.competition_prize_vouchers_id_seq OWNED BY public.competition_prize_vouchers.id;


--
-- Name: competitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.competitions (
    id bigint NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    description text,
    type text DEFAULT 'weekly'::text NOT NULL,
    status text DEFAULT 'upcoming'::text NOT NULL,
    start_at timestamp with time zone NOT NULL,
    end_at timestamp with time zone NOT NULL,
    entry_fee numeric DEFAULT 0 NOT NULL,
    starting_balance numeric DEFAULT 10000 NOT NULL,
    max_participants integer,
    ranking_metric text DEFAULT 'profit_pct'::text NOT NULL,
    max_drawdown_pct numeric DEFAULT 10 NOT NULL,
    daily_drawdown_pct numeric,
    rules_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    prize_pool_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    recurrence text,
    is_template boolean DEFAULT false NOT NULL,
    template_id bigint,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: competitions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.competitions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: competitions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.competitions_id_seq OWNED BY public.competitions.id;


--
-- Name: coupon_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coupon_codes (
    id bigint NOT NULL,
    code text NOT NULL,
    description text,
    discount_type text NOT NULL,
    discount_value numeric NOT NULL,
    max_redemptions integer,
    redemption_count integer DEFAULT 0 NOT NULL,
    min_order_amount numeric,
    expires_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT coupon_codes_discount_type_check CHECK ((discount_type = ANY (ARRAY['percent'::text, 'fixed'::text]))),
    CONSTRAINT coupon_codes_discount_value_check CHECK ((discount_value > (0)::numeric))
);


--
-- Name: coupon_codes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.coupon_codes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: coupon_codes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.coupon_codes_id_seq OWNED BY public.coupon_codes.id;


--
-- Name: coupon_redemptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coupon_redemptions (
    id bigint NOT NULL,
    coupon_id bigint NOT NULL,
    user_id uuid NOT NULL,
    order_id bigint,
    discount_amount numeric NOT NULL,
    redeemed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: coupon_redemptions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.coupon_redemptions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: coupon_redemptions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.coupon_redemptions_id_seq OWNED BY public.coupon_redemptions.id;


--
-- Name: daily_pnl_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_pnl_records (
    id bigint NOT NULL,
    account_id text NOT NULL,
    trading_date date NOT NULL,
    starting_equity numeric(15,2) NOT NULL,
    ending_equity numeric(15,2),
    realized_pnl numeric(15,2) DEFAULT 0 NOT NULL,
    peak_equity_eod numeric(15,2),
    is_qualifying_day boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: daily_pnl_records_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.daily_pnl_records_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: daily_pnl_records_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.daily_pnl_records_id_seq OWNED BY public.daily_pnl_records.id;


--
-- Name: disputes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.disputes (
    id bigint NOT NULL,
    user_id text NOT NULL,
    account_id text,
    reason text NOT NULL,
    description text NOT NULL,
    admin_reply text,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    admin_response text,
    violation_id bigint,
    evidence_path text
);


--
-- Name: disputes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.disputes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: disputes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.disputes_id_seq OWNED BY public.disputes.id;


--
-- Name: email_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_jobs (
    id bigint NOT NULL,
    user_id text,
    to_email text NOT NULL,
    template_key text NOT NULL,
    payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    last_error text,
    provider_message_id text,
    preview_url text,
    scheduled_for timestamp with time zone DEFAULT now() NOT NULL,
    last_attempt_at timestamp with time zone,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    unique_key text,
    CONSTRAINT email_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sending'::text, 'retry'::text, 'sent'::text, 'failed'::text, 'dead'::text])))
);


--
-- Name: email_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.email_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: email_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.email_jobs_id_seq OWNED BY public.email_jobs.id;


--
-- Name: gift_vouchers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gift_vouchers (
    id bigint NOT NULL,
    code text NOT NULL,
    purchaser_user_id uuid NOT NULL,
    order_id bigint,
    recipient_email text NOT NULL,
    recipient_user_id uuid,
    account_size numeric(12,2) NOT NULL,
    challenge_model_slug text NOT NULL,
    amount_paid numeric(12,2) DEFAULT 0 NOT NULL,
    gift_message text,
    status text DEFAULT 'issued'::text NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    claimed_at timestamp with time zone,
    claimed_order_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT gift_vouchers_status_check CHECK ((status = ANY (ARRAY['issued'::text, 'claimed'::text, 'expired'::text, 'revoked'::text])))
);


--
-- Name: gift_vouchers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.gift_vouchers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: gift_vouchers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.gift_vouchers_id_seq OWNED BY public.gift_vouchers.id;


--
-- Name: idempotency_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idempotency_requests (
    id bigint NOT NULL,
    actor_id text,
    scope text NOT NULL,
    idempotency_key text NOT NULL,
    status text DEFAULT 'started'::text NOT NULL,
    response_status integer,
    response_body_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: idempotency_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.idempotency_requests_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: idempotency_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.idempotency_requests_id_seq OWNED BY public.idempotency_requests.id;


--
-- Name: identity_signals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.identity_signals (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    signal_type text NOT NULL,
    signal_value text NOT NULL,
    context text,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    hit_count integer DEFAULT 1 NOT NULL
);


--
-- Name: identity_signals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.identity_signals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: identity_signals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.identity_signals_id_seq OWNED BY public.identity_signals.id;


--
--

--
--

--
--

--
--

--
--

--
--

--
-- Name: login_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.login_logs (
    id bigint NOT NULL,
    user_id text,
    ip_address text,
    logged_in_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: login_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.login_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: login_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.login_logs_id_seq OWNED BY public.login_logs.id;


--
-- Name: marketing_funnel_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketing_funnel_events (
    id bigint NOT NULL,
    event_type text DEFAULT 'visit'::text NOT NULL,
    session_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: marketing_funnel_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.marketing_funnel_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: marketing_funnel_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.marketing_funnel_events_id_seq OWNED BY public.marketing_funnel_events.id;


--
-- Name: news_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.news_cache (
    id bigint NOT NULL,
    title text NOT NULL,
    country text NOT NULL,
    impact text NOT NULL,
    event_time timestamp with time zone NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: news_cache_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.news_cache_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: news_cache_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.news_cache_id_seq OWNED BY public.news_cache.id;


--
-- Name: payouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payouts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    account_id uuid,
    amount_requested numeric(15,2),
    firm_cut numeric(15,2),
    amount_payable numeric(15,2),
    payment_method character varying(20),
    payment_details character varying(500),
    status character varying(20) DEFAULT 'pending'::character varying,
    requested_at timestamp without time zone DEFAULT now(),
    paid_at timestamp without time zone,
    transaction_id character varying(255),
    is_flagged boolean DEFAULT false,
    flag_reason text,
    admin_notes text
);


--
-- Name: phone_otp_pending; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.phone_otp_pending (
    id bigint NOT NULL,
    phone character varying(30) NOT NULL,
    otp_code character varying(6) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: phone_otp_pending_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.phone_otp_pending_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: phone_otp_pending_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.phone_otp_pending_id_seq OWNED BY public.phone_otp_pending.id;


--
-- Name: platform_admins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_admins (
    id bigint NOT NULL,
    email text NOT NULL,
    full_name text,
    password_hash text NOT NULL,
    role text DEFAULT 'super_admin'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    token_version integer DEFAULT 1 NOT NULL,
    totp_secret text,
    totp_temp_secret text,
    totp_backup_codes text,
    totp_enabled boolean DEFAULT false NOT NULL,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: platform_admins_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.platform_admins_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: platform_admins_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.platform_admins_id_seq OWNED BY public.platform_admins.id;


--
-- Name: platform_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_settings (
    key character varying(100) NOT NULL,
    value character varying(255) NOT NULL,
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: price_feed; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_feed (
    instrument character varying(20) NOT NULL,
    bid numeric(15,5),
    ask numeric(15,5),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: price_feed_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_feed_config (
    feed_name text DEFAULT 'default'::text NOT NULL,
    feed_mode text DEFAULT 'shared'::text NOT NULL,
    source_key text DEFAULT 'shared'::text NOT NULL,
    dwx_path text,
    fallback_to_shared boolean DEFAULT true NOT NULL,
    spread_markup_points_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: price_feed_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_feed_history (
    id integer NOT NULL,
    instrument text NOT NULL,
    bid numeric(12,5) NOT NULL,
    ask numeric(12,5) NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: price_feed_history_1h; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_feed_history_1h (
    id bigint NOT NULL,
    instrument text NOT NULL,
    bucket_time timestamp with time zone NOT NULL,
    open numeric NOT NULL,
    high numeric NOT NULL,
    low numeric NOT NULL,
    close numeric NOT NULL,
    ticks integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: price_feed_history_1h_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.price_feed_history_1h_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: price_feed_history_1h_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.price_feed_history_1h_id_seq OWNED BY public.price_feed_history_1h.id;


--
-- Name: price_feed_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.price_feed_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: price_feed_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.price_feed_history_id_seq OWNED BY public.price_feed_history.id;


--
-- Name: price_feed_source_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_feed_source_history (
    id bigint NOT NULL,
    source_key text NOT NULL,
    instrument text NOT NULL,
    bid numeric NOT NULL,
    ask numeric NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: price_feed_source_history_1h; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_feed_source_history_1h (
    id bigint NOT NULL,
    source_key text NOT NULL,
    instrument text NOT NULL,
    bucket_time timestamp with time zone NOT NULL,
    open numeric NOT NULL,
    high numeric NOT NULL,
    low numeric NOT NULL,
    close numeric NOT NULL,
    ticks integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: price_feed_source_history_1h_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.price_feed_source_history_1h_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: price_feed_source_history_1h_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.price_feed_source_history_1h_id_seq OWNED BY public.price_feed_source_history_1h.id;


--
-- Name: price_feed_source_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.price_feed_source_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: price_feed_source_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.price_feed_source_history_id_seq OWNED BY public.price_feed_source_history.id;


--
-- Name: price_feed_source_prices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_feed_source_prices (
    id bigint NOT NULL,
    source_key text NOT NULL,
    instrument text NOT NULL,
    bid numeric NOT NULL,
    ask numeric NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: price_feed_source_prices_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.price_feed_source_prices_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: price_feed_source_prices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.price_feed_source_prices_id_seq OWNED BY public.price_feed_source_prices.id;


--
-- Name: price_feed_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_feed_sources (
    id bigint NOT NULL,
    source_key text NOT NULL,
    source_name text NOT NULL,
    source_type text DEFAULT 'shared_env'::text NOT NULL,
    dwx_path text,
    status text DEFAULT 'active'::text NOT NULL,
    is_shared_default boolean DEFAULT false NOT NULL,
    last_seen_at timestamp with time zone,
    last_error_at timestamp with time zone,
    error_message text,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: price_feed_sources_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.price_feed_sources_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: price_feed_sources_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.price_feed_sources_id_seq OWNED BY public.price_feed_sources.id;


--
-- Name: referral_season_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.referral_season_entries (
    id bigint NOT NULL,
    season_id bigint NOT NULL,
    referrer_user_id uuid NOT NULL,
    new_paying_referrals integer DEFAULT 0 NOT NULL,
    final_rank integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: referral_season_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.referral_season_entries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: referral_season_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.referral_season_entries_id_seq OWNED BY public.referral_season_entries.id;


--
-- Name: referral_season_prize_vouchers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.referral_season_prize_vouchers (
    id bigint NOT NULL,
    code text NOT NULL,
    season_id bigint NOT NULL,
    season_entry_id bigint,
    user_id uuid NOT NULL,
    account_size numeric(12,2) NOT NULL,
    challenge_model_slug text NOT NULL,
    status text DEFAULT 'issued'::text NOT NULL,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    redeemed_at timestamp with time zone,
    redeemed_order_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT referral_season_prize_vouchers_status_check CHECK ((status = ANY (ARRAY['issued'::text, 'redeemed'::text, 'expired'::text, 'revoked'::text])))
);


--
-- Name: referral_season_prize_vouchers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.referral_season_prize_vouchers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: referral_season_prize_vouchers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.referral_season_prize_vouchers_id_seq OWNED BY public.referral_season_prize_vouchers.id;


--
-- Name: referral_seasons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.referral_seasons (
    id bigint NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    description text,
    status text DEFAULT 'upcoming'::text NOT NULL,
    start_at timestamp with time zone NOT NULL,
    end_at timestamp with time zone NOT NULL,
    ranking_metric text DEFAULT 'new_paying_referrals'::text NOT NULL,
    prize_pool_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT referral_seasons_status_check CHECK ((status = ANY (ARRAY['upcoming'::text, 'active'::text, 'completed'::text, 'cancelled'::text]))),
    CONSTRAINT referral_seasons_window_check CHECK ((end_at > start_at))
);


--
-- Name: referral_seasons_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.referral_seasons_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: referral_seasons_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.referral_seasons_id_seq OWNED BY public.referral_seasons.id;


--
-- Name: settings_change_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settings_change_log (
    id bigint NOT NULL,
    key text NOT NULL,
    old_value text,
    new_value text,
    changed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: settings_change_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.settings_change_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: settings_change_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.settings_change_log_id_seq OWNED BY public.settings_change_log.id;


--
-- Name: support_ticket_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_ticket_messages (
    id bigint NOT NULL,
    ticket_id bigint NOT NULL,
    sender_type text NOT NULL,
    sender_name text,
    message text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT support_ticket_messages_sender_type_check CHECK ((sender_type = ANY (ARRAY['user'::text, 'admin'::text])))
);


--
-- Name: support_ticket_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.support_ticket_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: support_ticket_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.support_ticket_messages_id_seq OWNED BY public.support_ticket_messages.id;


--
-- Name: support_tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_tickets (
    id bigint NOT NULL,
    user_id text,
    email text,
    name text,
    category text,
    subject text NOT NULL,
    message text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    assigned_agent text,
    sla_due_at timestamp with time zone,
    internal_notes text
);


--
-- Name: support_tickets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.support_tickets_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: support_tickets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.support_tickets_id_seq OWNED BY public.support_tickets.id;


--
-- Name: tenant_monthly_quotas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_monthly_quotas (
    id bigint NOT NULL,
    quota_month date NOT NULL,
    account_limit integer,
    is_unlimited boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tenant_monthly_quotas_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tenant_monthly_quotas_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tenant_monthly_quotas_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tenant_monthly_quotas_id_seq OWNED BY public.tenant_monthly_quotas.id;


--
-- Name: tenant_monthly_size_quotas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_monthly_size_quotas (
    id bigint NOT NULL,
    quota_month date NOT NULL,
    account_size integer NOT NULL,
    account_limit integer,
    is_unlimited boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tenant_monthly_size_quotas_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tenant_monthly_size_quotas_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tenant_monthly_size_quotas_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tenant_monthly_size_quotas_id_seq OWNED BY public.tenant_monthly_size_quotas.id;


--
-- Name: trade_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trade_logs (
    id bigint NOT NULL,
    trade_id text,
    user_id text,
    account_id text,
    ip_address text,
    logged_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: trade_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trade_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trade_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trade_logs_id_seq OWNED BY public.trade_logs.id;


--
-- Name: trader_id_sequences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trader_id_sequences (
    id integer NOT NULL,
    last_value integer DEFAULT 0 NOT NULL
);


--
-- Name: trades; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trades (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid,
    demo_trade_id character varying(100),
    broker_trade_id character varying(100),
    instrument character varying(20) NOT NULL,
    direction character varying(10) NOT NULL,
    broker_direction character varying(10),
    lot_size numeric(10,4) NOT NULL,
    open_price numeric(15,5),
    close_price numeric(15,5),
    open_time timestamp without time zone DEFAULT now(),
    close_time timestamp without time zone,
    demo_pnl numeric(15,2) DEFAULT 0,
    broker_pnl numeric(15,2) DEFAULT 0,
    status character varying(10) DEFAULT 'open'::character varying,
    stop_loss numeric(12,5),
    take_profit numeric(12,5),
    order_type character varying(20) DEFAULT 'market'::character varying,
    pending_price numeric(20,8),
    close_reason character varying(100),
    trader_note text,
    parent_trade_id integer,
    is_partial boolean DEFAULT false,
    commission numeric(15,2) DEFAULT 0.00,
    notes text,
    tags jsonb DEFAULT '[]'::jsonb,
    trailing_activation_price numeric(15,5),
    trailing_step_pips integer,
    slippage_pips numeric(5,2) DEFAULT 0,
    original_commission numeric(10,2),
    strategy_tag text,
    open_screenshot_path text,
    close_screenshot_path text,
    breakeven_trigger_pips numeric(10,2),
    oco_group_id text
);


--
-- Name: user_agreement_acceptances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_agreement_acceptances (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    tos_version text NOT NULL,
    accepted_at timestamp with time zone DEFAULT now() NOT NULL,
    ip_address text
);


--
-- Name: user_agreement_acceptances_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_agreement_acceptances_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_agreement_acceptances_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_agreement_acceptances_id_seq OWNED BY public.user_agreement_acceptances.id;


--
-- Name: user_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_notifications (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    type text DEFAULT 'info'::text NOT NULL,
    title text,
    message text NOT NULL,
    read boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_notifications_id_seq OWNED BY public.user_notifications.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email character varying(255) NOT NULL,
    password_hash character varying(255) NOT NULL,
    full_name character varying(255) NOT NULL,
    country character varying(100) NOT NULL,
    phone character varying(50),
    kyc_status character varying(20) DEFAULT 'pending'::character varying,
    kyc_document_url character varying(500),
    device_fingerprint character varying(255),
    is_banned boolean DEFAULT false,
    affiliate_code character varying(50),
    referred_by character varying(50),
    created_at timestamp without time zone DEFAULT now(),
    id_document_path character varying(500),
    selfie_path character varying(500),
    kyc_submitted_at timestamp without time zone,
    kyc_rejection_reason text,
    id_document_hash character varying(64) DEFAULT NULL::character varying,
    theme_preference character varying(10) DEFAULT 'dark'::character varying,
    token_version integer DEFAULT 1,
    trader_uid text,
    totp_secret text,
    totp_enabled boolean DEFAULT false,
    totp_temp_secret text,
    totp_backup_codes text,
    leaderboard_visible boolean DEFAULT true NOT NULL,
    reset_token text,
    reset_token_expires timestamp with time zone,
    kyc_document_country text,
    kyc_document_type text,
    kyc_document_number text,
    id_document_back_path text,
    phone_verified boolean DEFAULT false NOT NULL,
    signup_source text,
    address_line1 text,
    address_line2 text,
    city text,
    state_province text,
    postal_code text,
    updated_at timestamp with time zone,
    is_bot boolean DEFAULT false NOT NULL
);


--
-- Name: ab_experiment_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ab_experiment_events ALTER COLUMN id SET DEFAULT nextval('public.ab_experiment_events_id_seq'::regclass);


--
-- Name: ab_experiments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ab_experiments ALTER COLUMN id SET DEFAULT nextval('public.ab_experiments_id_seq'::regclass);


--
-- Name: account_link_clusters id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_link_clusters ALTER COLUMN id SET DEFAULT nextval('public.account_link_clusters_id_seq'::regclass);


--
-- Name: account_link_evidence id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_link_evidence ALTER COLUMN id SET DEFAULT nextval('public.account_link_evidence_id_seq'::regclass);


--
-- Name: account_promotion_reviews id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_promotion_reviews ALTER COLUMN id SET DEFAULT nextval('public.account_promotion_reviews_id_seq'::regclass);


--
-- Name: admin_audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit_log ALTER COLUMN id SET DEFAULT nextval('public.admin_audit_log_id_seq'::regclass);


--
-- Name: admin_balance_adjustments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_balance_adjustments ALTER COLUMN id SET DEFAULT nextval('public.admin_balance_adjustments_id_seq'::regclass);


--
-- Name: admin_cases id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_cases ALTER COLUMN id SET DEFAULT nextval('public.admin_cases_id_seq'::regclass);


--
-- Name: admin_dispute_meta id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_dispute_meta ALTER COLUMN id SET DEFAULT nextval('public.admin_dispute_meta_id_seq'::regclass);


--
-- Name: admin_enforcement_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_enforcement_events ALTER COLUMN id SET DEFAULT nextval('public.admin_enforcement_events_id_seq'::regclass);


--
-- Name: admin_entity_meta id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_entity_meta ALTER COLUMN id SET DEFAULT nextval('public.admin_entity_meta_id_seq'::regclass);


--
-- Name: admin_entity_notes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_entity_notes ALTER COLUMN id SET DEFAULT nextval('public.admin_entity_notes_id_seq'::regclass);


--
-- Name: admin_entity_tags id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_entity_tags ALTER COLUMN id SET DEFAULT nextval('public.admin_entity_tags_id_seq'::regclass);


--
-- Name: admin_feature_flags id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_feature_flags ALTER COLUMN id SET DEFAULT nextval('public.admin_feature_flags_id_seq'::regclass);


--
-- Name: admin_four_eyes_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_four_eyes_requests ALTER COLUMN id SET DEFAULT nextval('public.admin_four_eyes_requests_id_seq'::regclass);


--
-- Name: admin_immutable_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_immutable_audit ALTER COLUMN id SET DEFAULT nextval('public.admin_immutable_audit_id_seq'::regclass);


--
-- Name: admin_incidents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_incidents ALTER COLUMN id SET DEFAULT nextval('public.admin_incidents_id_seq'::regclass);


--
-- Name: admin_notes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notes ALTER COLUMN id SET DEFAULT nextval('public.admin_notes_id_seq'::regclass);


--
-- Name: admin_notifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notifications ALTER COLUMN id SET DEFAULT nextval('public.admin_notifications_id_seq'::regclass);


--
-- Name: admin_rule_violations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_rule_violations ALTER COLUMN id SET DEFAULT nextval('public.admin_rule_violations_id_seq'::regclass);


--
-- Name: admin_rules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_rules ALTER COLUMN id SET DEFAULT nextval('public.admin_rules_id_seq'::regclass);


--
-- Name: admin_saved_views id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_saved_views ALTER COLUMN id SET DEFAULT nextval('public.admin_saved_views_id_seq'::regclass);


--
-- Name: admin_scheduled_reports id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_scheduled_reports ALTER COLUMN id SET DEFAULT nextval('public.admin_scheduled_reports_id_seq'::regclass);


--
-- Name: affiliate_commission_tiers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_commission_tiers ALTER COLUMN id SET DEFAULT nextval('public.affiliate_commission_tiers_id_seq'::regclass);


--
-- Name: affiliate_commissions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_commissions ALTER COLUMN id SET DEFAULT nextval('public.affiliate_commissions_id_seq'::regclass);


--
-- Name: affiliate_payout_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_payout_requests ALTER COLUMN id SET DEFAULT nextval('public.affiliate_payout_requests_id_seq'::regclass);


--
-- Name: affiliate_referrals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_referrals ALTER COLUMN id SET DEFAULT nextval('public.affiliate_referrals_id_seq'::regclass);


--
-- Name: announcements id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcements ALTER COLUMN id SET DEFAULT nextval('public.announcements_id_seq'::regclass);


--
-- Name: balance_adjustments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.balance_adjustments ALTER COLUMN id SET DEFAULT nextval('public.balance_adjustments_id_seq'::regclass);


--
-- Name: challenge_checkout_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.challenge_checkout_sessions ALTER COLUMN id SET DEFAULT nextval('public.challenge_checkout_sessions_id_seq'::regclass);


--
-- Name: challenge_model_pricing id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.challenge_model_pricing ALTER COLUMN id SET DEFAULT nextval('public.challenge_model_pricing_id_seq'::regclass);


--
-- Name: challenge_models id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.challenge_models ALTER COLUMN id SET DEFAULT nextval('public.challenge_models_id_seq'::regclass);


--
-- Name: challenge_orders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.challenge_orders ALTER COLUMN id SET DEFAULT nextval('public.challenge_orders_id_seq'::regclass);


--
-- Name: challenge_payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.challenge_payments ALTER COLUMN id SET DEFAULT nextval('public.challenge_payments_id_seq'::regclass);


--
-- Name: challenge_products id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.challenge_products ALTER COLUMN id SET DEFAULT nextval('public.challenge_products_id_seq'::regclass);


--
-- Name: chat_conversations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_conversations ALTER COLUMN id SET DEFAULT nextval('public.chat_conversations_id_seq'::regclass);


--
-- Name: chat_messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages ALTER COLUMN id SET DEFAULT nextval('public.chat_messages_id_seq'::regclass);


--
-- Name: competition_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competition_entries ALTER COLUMN id SET DEFAULT nextval('public.competition_entries_id_seq'::regclass);


--
-- Name: competition_prize_vouchers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competition_prize_vouchers ALTER COLUMN id SET DEFAULT nextval('public.competition_prize_vouchers_id_seq'::regclass);


--
-- Name: competitions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competitions ALTER COLUMN id SET DEFAULT nextval('public.competitions_id_seq'::regclass);


--
-- Name: coupon_codes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupon_codes ALTER COLUMN id SET DEFAULT nextval('public.coupon_codes_id_seq'::regclass);


--
-- Name: coupon_redemptions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupon_redemptions ALTER COLUMN id SET DEFAULT nextval('public.coupon_redemptions_id_seq'::regclass);


--
-- Name: daily_pnl_records id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_pnl_records ALTER COLUMN id SET DEFAULT nextval('public.daily_pnl_records_id_seq'::regclass);


--
-- Name: disputes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.disputes ALTER COLUMN id SET DEFAULT nextval('public.disputes_id_seq'::regclass);


--
-- Name: email_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_jobs ALTER COLUMN id SET DEFAULT nextval('public.email_jobs_id_seq'::regclass);


--
-- Name: gift_vouchers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gift_vouchers ALTER COLUMN id SET DEFAULT nextval('public.gift_vouchers_id_seq'::regclass);


--
-- Name: idempotency_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_requests ALTER COLUMN id SET DEFAULT nextval('public.idempotency_requests_id_seq'::regclass);


--
-- Name: identity_signals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_signals ALTER COLUMN id SET DEFAULT nextval('public.identity_signals_id_seq'::regclass);


--
--

--
--

--
-- Name: login_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_logs ALTER COLUMN id SET DEFAULT nextval('public.login_logs_id_seq'::regclass);


--
-- Name: marketing_funnel_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_funnel_events ALTER COLUMN id SET DEFAULT nextval('public.marketing_funnel_events_id_seq'::regclass);


--
-- Name: news_cache id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.news_cache ALTER COLUMN id SET DEFAULT nextval('public.news_cache_id_seq'::regclass);


--
-- Name: phone_otp_pending id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phone_otp_pending ALTER COLUMN id SET DEFAULT nextval('public.phone_otp_pending_id_seq'::regclass);


--
-- Name: platform_admins id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_admins ALTER COLUMN id SET DEFAULT nextval('public.platform_admins_id_seq'::regclass);


--
-- Name: price_feed_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_feed_history ALTER COLUMN id SET DEFAULT nextval('public.price_feed_history_id_seq'::regclass);


--
-- Name: price_feed_history_1h id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_feed_history_1h ALTER COLUMN id SET DEFAULT nextval('public.price_feed_history_1h_id_seq'::regclass);


--
-- Name: price_feed_source_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_feed_source_history ALTER COLUMN id SET DEFAULT nextval('public.price_feed_source_history_id_seq'::regclass);


--
-- Name: price_feed_source_history_1h id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_feed_source_history_1h ALTER COLUMN id SET DEFAULT nextval('public.price_feed_source_history_1h_id_seq'::regclass);


--
-- Name: price_feed_source_prices id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_feed_source_prices ALTER COLUMN id SET DEFAULT nextval('public.price_feed_source_prices_id_seq'::regclass);


--
-- Name: price_feed_sources id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_feed_sources ALTER COLUMN id SET DEFAULT nextval('public.price_feed_sources_id_seq'::regclass);


--
-- Name: referral_season_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_season_entries ALTER COLUMN id SET DEFAULT nextval('public.referral_season_entries_id_seq'::regclass);


--
-- Name: referral_season_prize_vouchers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_season_prize_vouchers ALTER COLUMN id SET DEFAULT nextval('public.referral_season_prize_vouchers_id_seq'::regclass);


--
-- Name: referral_seasons id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_seasons ALTER COLUMN id SET DEFAULT nextval('public.referral_seasons_id_seq'::regclass);


--
-- Name: settings_change_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings_change_log ALTER COLUMN id SET DEFAULT nextval('public.settings_change_log_id_seq'::regclass);


--
-- Name: support_ticket_messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_ticket_messages ALTER COLUMN id SET DEFAULT nextval('public.support_ticket_messages_id_seq'::regclass);


--
-- Name: support_tickets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets ALTER COLUMN id SET DEFAULT nextval('public.support_tickets_id_seq'::regclass);


--
-- Name: tenant_monthly_quotas id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_monthly_quotas ALTER COLUMN id SET DEFAULT nextval('public.tenant_monthly_quotas_id_seq'::regclass);


--
-- Name: tenant_monthly_size_quotas id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_monthly_size_quotas ALTER COLUMN id SET DEFAULT nextval('public.tenant_monthly_size_quotas_id_seq'::regclass);


--
-- Name: trade_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trade_logs ALTER COLUMN id SET DEFAULT nextval('public.trade_logs_id_seq'::regclass);


--
-- Name: user_agreement_acceptances id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_agreement_acceptances ALTER COLUMN id SET DEFAULT nextval('public.user_agreement_acceptances_id_seq'::regclass);


--
-- Name: user_notifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_notifications ALTER COLUMN id SET DEFAULT nextval('public.user_notifications_id_seq'::regclass);


--
-- Name: ab_experiment_events ab_experiment_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ab_experiment_events
    ADD CONSTRAINT ab_experiment_events_pkey PRIMARY KEY (id);


--
-- Name: ab_experiments ab_experiments_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ab_experiments
    ADD CONSTRAINT ab_experiments_key_key UNIQUE (key);


--
-- Name: ab_experiments ab_experiments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ab_experiments
    ADD CONSTRAINT ab_experiments_pkey PRIMARY KEY (id);


--
-- Name: account_id_sequences account_id_sequences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_id_sequences
    ADD CONSTRAINT account_id_sequences_pkey PRIMARY KEY (category);


--
-- Name: account_link_clusters account_link_clusters_cluster_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_link_clusters
    ADD CONSTRAINT account_link_clusters_cluster_key_key UNIQUE (cluster_key);


--
-- Name: account_link_clusters account_link_clusters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_link_clusters
    ADD CONSTRAINT account_link_clusters_pkey PRIMARY KEY (id);


--
-- Name: account_link_evidence account_link_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_link_evidence
    ADD CONSTRAINT account_link_evidence_pkey PRIMARY KEY (id);


--
-- Name: account_promotion_reviews account_promotion_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_promotion_reviews
    ADD CONSTRAINT account_promotion_reviews_pkey PRIMARY KEY (id);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: admin_audit_log admin_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit_log
    ADD CONSTRAINT admin_audit_log_pkey PRIMARY KEY (id);


--
-- Name: admin_balance_adjustments admin_balance_adjustments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_balance_adjustments
    ADD CONSTRAINT admin_balance_adjustments_pkey PRIMARY KEY (id);


--
-- Name: admin_cases admin_cases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_cases
    ADD CONSTRAINT admin_cases_pkey PRIMARY KEY (id);


--
-- Name: admin_dispute_meta admin_dispute_meta_dispute_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_dispute_meta
    ADD CONSTRAINT admin_dispute_meta_dispute_id_key UNIQUE (dispute_id);


--
-- Name: admin_dispute_meta admin_dispute_meta_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_dispute_meta
    ADD CONSTRAINT admin_dispute_meta_pkey PRIMARY KEY (id);


--
-- Name: admin_enforcement_events admin_enforcement_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_enforcement_events
    ADD CONSTRAINT admin_enforcement_events_pkey PRIMARY KEY (id);


--
-- Name: admin_entity_meta admin_entity_meta_entity_type_entity_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_entity_meta
    ADD CONSTRAINT admin_entity_meta_entity_type_entity_id_key UNIQUE (entity_type, entity_id);


--
-- Name: admin_entity_meta admin_entity_meta_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_entity_meta
    ADD CONSTRAINT admin_entity_meta_pkey PRIMARY KEY (id);


--
-- Name: admin_entity_notes admin_entity_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_entity_notes
    ADD CONSTRAINT admin_entity_notes_pkey PRIMARY KEY (id);


--
-- Name: admin_entity_tags admin_entity_tags_entity_type_entity_id_tag_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_entity_tags
    ADD CONSTRAINT admin_entity_tags_entity_type_entity_id_tag_key UNIQUE (entity_type, entity_id, tag);


--
-- Name: admin_entity_tags admin_entity_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_entity_tags
    ADD CONSTRAINT admin_entity_tags_pkey PRIMARY KEY (id);


--
-- Name: admin_feature_flags admin_feature_flags_flag_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_feature_flags
    ADD CONSTRAINT admin_feature_flags_flag_key_key UNIQUE (flag_key);


--
-- Name: admin_feature_flags admin_feature_flags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_feature_flags
    ADD CONSTRAINT admin_feature_flags_pkey PRIMARY KEY (id);


--
-- Name: admin_four_eyes_requests admin_four_eyes_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_four_eyes_requests
    ADD CONSTRAINT admin_four_eyes_requests_pkey PRIMARY KEY (id);


--
-- Name: admin_immutable_audit admin_immutable_audit_entry_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_immutable_audit
    ADD CONSTRAINT admin_immutable_audit_entry_hash_key UNIQUE (entry_hash);


--
-- Name: admin_immutable_audit admin_immutable_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_immutable_audit
    ADD CONSTRAINT admin_immutable_audit_pkey PRIMARY KEY (id);


--
-- Name: admin_incidents admin_incidents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_incidents
    ADD CONSTRAINT admin_incidents_pkey PRIMARY KEY (id);


--
-- Name: admin_notes admin_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notes
    ADD CONSTRAINT admin_notes_pkey PRIMARY KEY (id);


--
-- Name: admin_notifications admin_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notifications
    ADD CONSTRAINT admin_notifications_pkey PRIMARY KEY (id);


--
-- Name: admin_rule_violations admin_rule_violations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_rule_violations
    ADD CONSTRAINT admin_rule_violations_pkey PRIMARY KEY (id);


--
-- Name: admin_rule_violations admin_rule_violations_violation_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_rule_violations
    ADD CONSTRAINT admin_rule_violations_violation_key_key UNIQUE (violation_key);


--
-- Name: admin_rules admin_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_rules
    ADD CONSTRAINT admin_rules_pkey PRIMARY KEY (id);


--
-- Name: admin_saved_views admin_saved_views_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_saved_views
    ADD CONSTRAINT admin_saved_views_pkey PRIMARY KEY (id);


--
-- Name: admin_scheduled_reports admin_scheduled_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_scheduled_reports
    ADD CONSTRAINT admin_scheduled_reports_pkey PRIMARY KEY (id);


--
-- Name: affiliate_commission_tiers affiliate_commission_tiers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_commission_tiers
    ADD CONSTRAINT affiliate_commission_tiers_pkey PRIMARY KEY (id);


--
-- Name: affiliate_commission_tiers affiliate_commission_tiers_tier_rank_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_commission_tiers
    ADD CONSTRAINT affiliate_commission_tiers_tier_rank_key UNIQUE (tier_rank);


--
-- Name: affiliate_commissions affiliate_commissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_commissions
    ADD CONSTRAINT affiliate_commissions_pkey PRIMARY KEY (id);


--
-- Name: affiliate_payout_requests affiliate_payout_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_payout_requests
    ADD CONSTRAINT affiliate_payout_requests_pkey PRIMARY KEY (id);


--
-- Name: affiliate_referrals affiliate_referrals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_referrals
    ADD CONSTRAINT affiliate_referrals_pkey PRIMARY KEY (id);


--
-- Name: announcements announcements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_pkey PRIMARY KEY (id);


--
-- Name: balance_adjustments balance_adjustments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.balance_adjustments
    ADD CONSTRAINT balance_adjustments_pkey PRIMARY KEY (id);


--
-- Name: bbook_pnl bbook_pnl_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bbook_pnl
    ADD CONSTRAINT bbook_pnl_date_key UNIQUE (date);


--
-- Name: bbook_pnl bbook_pnl_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bbook_pnl
    ADD CONSTRAINT bbook_pnl_pkey PRIMARY KEY (date);


--
-- Name: challenge_checkout_sessions challenge_checkout_sessions_checkout_session_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.challenge_checkout_sessions
    ADD CONSTRAINT challenge_checkout_sessions_checkout_session_id_key UNIQUE (checkout_session_id);


--
-- Name: challenge_checkout_sessions challenge_checkout_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.challenge_checkout_sessions
    ADD CONSTRAINT challenge_checkout_sessions_pkey PRIMARY KEY (id);


--
-- Name: challenge_model_pricing challenge_model_pricing_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.challenge_model_pricing
    ADD CONSTRAINT challenge_model_pricing_pkey PRIMARY KEY (id);


--
-- Name: challenge_models challenge_models_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.challenge_models
    ADD CONSTRAINT challenge_models_pkey PRIMARY KEY (id);


--
-- Name: challenge_orders challenge_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.challenge_orders
    ADD CONSTRAINT challenge_orders_pkey PRIMARY KEY (id);


--
-- Name: challenge_payments challenge_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.challenge_payments
    ADD CONSTRAINT challenge_payments_pkey PRIMARY KEY (id);


--
-- Name: challenge_products challenge_products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.challenge_products
    ADD CONSTRAINT challenge_products_pkey PRIMARY KEY (id);


--
-- Name: chat_conversations chat_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_conversations
    ADD CONSTRAINT chat_conversations_pkey PRIMARY KEY (id);


--
-- Name: chat_messages chat_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);


--
-- Name: competition_entries competition_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competition_entries
    ADD CONSTRAINT competition_entries_pkey PRIMARY KEY (id);


--
-- Name: competition_prize_vouchers competition_prize_vouchers_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competition_prize_vouchers
    ADD CONSTRAINT competition_prize_vouchers_code_key UNIQUE (code);


--
-- Name: competition_prize_vouchers competition_prize_vouchers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competition_prize_vouchers
    ADD CONSTRAINT competition_prize_vouchers_pkey PRIMARY KEY (id);


--
-- Name: competitions competitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competitions
    ADD CONSTRAINT competitions_pkey PRIMARY KEY (id);


--
-- Name: competitions competitions_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competitions
    ADD CONSTRAINT competitions_slug_key UNIQUE (slug);


--
-- Name: coupon_codes coupon_codes_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupon_codes
    ADD CONSTRAINT coupon_codes_code_key UNIQUE (code);


--
-- Name: coupon_codes coupon_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupon_codes
    ADD CONSTRAINT coupon_codes_pkey PRIMARY KEY (id);


--
-- Name: coupon_redemptions coupon_redemptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupon_redemptions
    ADD CONSTRAINT coupon_redemptions_pkey PRIMARY KEY (id);


--
-- Name: daily_pnl_records daily_pnl_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_pnl_records
    ADD CONSTRAINT daily_pnl_records_pkey PRIMARY KEY (id);


--
-- Name: disputes disputes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.disputes
    ADD CONSTRAINT disputes_pkey PRIMARY KEY (id);


--
-- Name: email_jobs email_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_jobs
    ADD CONSTRAINT email_jobs_pkey PRIMARY KEY (id);


--
-- Name: gift_vouchers gift_vouchers_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gift_vouchers
    ADD CONSTRAINT gift_vouchers_code_key UNIQUE (code);


--
-- Name: gift_vouchers gift_vouchers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gift_vouchers
    ADD CONSTRAINT gift_vouchers_pkey PRIMARY KEY (id);


--
-- Name: idempotency_requests idempotency_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_requests
    ADD CONSTRAINT idempotency_requests_pkey PRIMARY KEY (id);


--
-- Name: identity_signals identity_signals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_signals
    ADD CONSTRAINT identity_signals_pkey PRIMARY KEY (id);


--
-- Name: identity_signals identity_signals_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_signals
    ADD CONSTRAINT identity_signals_uq UNIQUE (user_id, signal_type, signal_value);


--
--

--
--

--
-- Name: login_logs login_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_logs
    ADD CONSTRAINT login_logs_pkey PRIMARY KEY (id);


--
-- Name: marketing_funnel_events marketing_funnel_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_funnel_events
    ADD CONSTRAINT marketing_funnel_events_pkey PRIMARY KEY (id);


--
-- Name: news_cache news_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.news_cache
    ADD CONSTRAINT news_cache_pkey PRIMARY KEY (id);


--
-- Name: news_cache news_cache_title_event_time_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.news_cache
    ADD CONSTRAINT news_cache_title_event_time_key UNIQUE (title, event_time);


--
-- Name: payouts payouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payouts
    ADD CONSTRAINT payouts_pkey PRIMARY KEY (id);


--
-- Name: phone_otp_pending phone_otp_pending_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phone_otp_pending
    ADD CONSTRAINT phone_otp_pending_pkey PRIMARY KEY (id);


--
-- Name: platform_admins platform_admins_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_admins
    ADD CONSTRAINT platform_admins_email_key UNIQUE (email);


--
-- Name: platform_admins platform_admins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_admins
    ADD CONSTRAINT platform_admins_pkey PRIMARY KEY (id);


--
-- Name: platform_settings platform_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_settings
    ADD CONSTRAINT platform_settings_pkey PRIMARY KEY (key);


--
-- Name: price_feed_config price_feed_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_feed_config
    ADD CONSTRAINT price_feed_config_pkey PRIMARY KEY (feed_name);


--
-- Name: price_feed_history_1h price_feed_history_1h_instrument_bucket_time_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_feed_history_1h
    ADD CONSTRAINT price_feed_history_1h_instrument_bucket_time_key UNIQUE (instrument, bucket_time);


--
-- Name: price_feed_history_1h price_feed_history_1h_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_feed_history_1h
    ADD CONSTRAINT price_feed_history_1h_pkey PRIMARY KEY (id);


--
-- Name: price_feed_history price_feed_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_feed_history
    ADD CONSTRAINT price_feed_history_pkey PRIMARY KEY (id);


--
-- Name: price_feed price_feed_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_feed
    ADD CONSTRAINT price_feed_pkey PRIMARY KEY (instrument);


--
-- Name: price_feed_source_history_1h price_feed_source_history_1h_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_feed_source_history_1h
    ADD CONSTRAINT price_feed_source_history_1h_pkey PRIMARY KEY (id);


--
-- Name: price_feed_source_history_1h price_feed_source_history_1h_source_key_instrument_bucket_t_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_feed_source_history_1h
    ADD CONSTRAINT price_feed_source_history_1h_source_key_instrument_bucket_t_key UNIQUE (source_key, instrument, bucket_time);


--
-- Name: price_feed_source_history price_feed_source_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_feed_source_history
    ADD CONSTRAINT price_feed_source_history_pkey PRIMARY KEY (id);


--
-- Name: price_feed_source_prices price_feed_source_prices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_feed_source_prices
    ADD CONSTRAINT price_feed_source_prices_pkey PRIMARY KEY (id);


--
-- Name: price_feed_source_prices price_feed_source_prices_source_key_instrument_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_feed_source_prices
    ADD CONSTRAINT price_feed_source_prices_source_key_instrument_key UNIQUE (source_key, instrument);


--
-- Name: price_feed_sources price_feed_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_feed_sources
    ADD CONSTRAINT price_feed_sources_pkey PRIMARY KEY (id);


--
-- Name: price_feed_sources price_feed_sources_source_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_feed_sources
    ADD CONSTRAINT price_feed_sources_source_key_key UNIQUE (source_key);


--
-- Name: referral_season_entries referral_season_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_season_entries
    ADD CONSTRAINT referral_season_entries_pkey PRIMARY KEY (id);


--
-- Name: referral_season_entries referral_season_entries_season_id_referrer_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_season_entries
    ADD CONSTRAINT referral_season_entries_season_id_referrer_user_id_key UNIQUE (season_id, referrer_user_id);


--
-- Name: referral_season_prize_vouchers referral_season_prize_vouchers_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_season_prize_vouchers
    ADD CONSTRAINT referral_season_prize_vouchers_code_key UNIQUE (code);


--
-- Name: referral_season_prize_vouchers referral_season_prize_vouchers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_season_prize_vouchers
    ADD CONSTRAINT referral_season_prize_vouchers_pkey PRIMARY KEY (id);


--
-- Name: referral_seasons referral_seasons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_seasons
    ADD CONSTRAINT referral_seasons_pkey PRIMARY KEY (id);


--
-- Name: referral_seasons referral_seasons_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_seasons
    ADD CONSTRAINT referral_seasons_slug_key UNIQUE (slug);


--
-- Name: settings_change_log settings_change_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings_change_log
    ADD CONSTRAINT settings_change_log_pkey PRIMARY KEY (id);


--
-- Name: support_ticket_messages support_ticket_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_ticket_messages
    ADD CONSTRAINT support_ticket_messages_pkey PRIMARY KEY (id);


--
-- Name: support_tickets support_tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_pkey PRIMARY KEY (id);


--
-- Name: tenant_monthly_quotas tenant_monthly_quotas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_monthly_quotas
    ADD CONSTRAINT tenant_monthly_quotas_pkey PRIMARY KEY (id);


--
-- Name: tenant_monthly_quotas tenant_monthly_quotas_quota_month_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_monthly_quotas
    ADD CONSTRAINT tenant_monthly_quotas_quota_month_key UNIQUE (quota_month);


--
-- Name: tenant_monthly_size_quotas tenant_monthly_size_quotas_month_size_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_monthly_size_quotas
    ADD CONSTRAINT tenant_monthly_size_quotas_month_size_key UNIQUE (quota_month, account_size);


--
-- Name: tenant_monthly_size_quotas tenant_monthly_size_quotas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_monthly_size_quotas
    ADD CONSTRAINT tenant_monthly_size_quotas_pkey PRIMARY KEY (id);


--
-- Name: trade_logs trade_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trade_logs
    ADD CONSTRAINT trade_logs_pkey PRIMARY KEY (id);


--
-- Name: trader_id_sequences trader_id_sequences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trader_id_sequences
    ADD CONSTRAINT trader_id_sequences_pkey PRIMARY KEY (id);


--
-- Name: trades trades_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trades
    ADD CONSTRAINT trades_pkey PRIMARY KEY (id);


--
-- Name: daily_pnl_records uq_daily_pnl_acc_date; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_pnl_records
    ADD CONSTRAINT uq_daily_pnl_acc_date UNIQUE (account_id, trading_date);


--
-- Name: challenge_model_pricing uq_model_pricing; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.challenge_model_pricing
    ADD CONSTRAINT uq_model_pricing UNIQUE (challenge_model_id, account_size);


--
-- Name: user_agreement_acceptances user_agreement_acceptances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_agreement_acceptances
    ADD CONSTRAINT user_agreement_acceptances_pkey PRIMARY KEY (id);


--
-- Name: user_notifications user_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_notifications
    ADD CONSTRAINT user_notifications_pkey PRIMARY KEY (id);


--
-- Name: users users_affiliate_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_affiliate_code_key UNIQUE (affiliate_code);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: account_link_clusters_members_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_link_clusters_members_idx ON public.account_link_clusters USING gin (member_user_ids);


--
-- Name: account_link_clusters_triage_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_link_clusters_triage_idx ON public.account_link_clusters USING btree (status, score DESC, last_detected_at DESC);


--
-- Name: account_link_evidence_cluster_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_link_evidence_cluster_idx ON public.account_link_evidence USING btree (cluster_id);


--
-- Name: account_promotion_reviews_pending_source_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX account_promotion_reviews_pending_source_uq ON public.account_promotion_reviews USING btree (source_account_id) WHERE (status = 'pending'::text);


--
-- Name: account_promotion_reviews_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_promotion_reviews_source_idx ON public.account_promotion_reviews USING btree (source_account_id);


--
-- Name: account_promotion_reviews_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_promotion_reviews_status_idx ON public.account_promotion_reviews USING btree (status, created_at DESC);


--
-- Name: accounts_account_uid_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX accounts_account_uid_uq ON public.accounts USING btree (account_uid);


--
-- Name: accounts_user_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX accounts_user_status_idx ON public.accounts USING btree (user_id, status);


--
-- Name: admin_rule_violations_violation_key_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX admin_rule_violations_violation_key_uq ON public.admin_rule_violations USING btree (violation_key);


--
-- Name: bbook_pnl_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bbook_pnl_date_idx ON public.bbook_pnl USING btree (date DESC);


--
-- Name: bbook_pnl_date_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX bbook_pnl_date_uq ON public.bbook_pnl USING btree (date);


--
-- Name: chat_conversations_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_conversations_status_created_idx ON public.chat_conversations USING btree (status, created_at DESC);


--
-- Name: chat_conversations_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_conversations_status_idx ON public.chat_conversations USING btree (status);


--
-- Name: chat_conversations_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_conversations_user_id_idx ON public.chat_conversations USING btree (user_id);


--
-- Name: chat_messages_conversation_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_messages_conversation_created_idx ON public.chat_messages USING btree (conversation_id, created_at);


--
-- Name: chat_messages_conversation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_messages_conversation_idx ON public.chat_messages USING btree (conversation_id);


--
-- Name: chat_messages_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_messages_created_at_idx ON public.chat_messages USING btree (created_at DESC);


--
-- Name: disputes_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX disputes_created_idx ON public.disputes USING btree (created_at DESC);


--
-- Name: idempotency_requests_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idempotency_requests_created_idx ON public.idempotency_requests USING btree (created_at DESC);


--
-- Name: idempotency_requests_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idempotency_requests_scope_idx ON public.idempotency_requests USING btree (scope, created_at DESC);


--
-- Name: idempotency_requests_scope_key_actor_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idempotency_requests_scope_key_actor_uq ON public.idempotency_requests USING btree (scope, idempotency_key, COALESCE(actor_id, ''::text));


--
-- Name: idempotency_requests_started_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idempotency_requests_started_created_idx ON public.idempotency_requests USING btree (created_at) WHERE (status = 'started'::text);


--
-- Name: identity_signals_last_seen_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX identity_signals_last_seen_idx ON public.identity_signals USING btree (last_seen_at);


--
-- Name: identity_signals_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX identity_signals_user_idx ON public.identity_signals USING btree (user_id);


--
-- Name: identity_signals_value_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX identity_signals_value_idx ON public.identity_signals USING btree (signal_type, signal_value);


--
-- Name: idx_ab_experiment_events_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ab_experiment_events_key ON public.ab_experiment_events USING btree (experiment_key, variant_key);


--
-- Name: idx_accounts_challenge_model_size; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_challenge_model_size ON public.accounts USING btree (challenge_model_id, account_size);


--
-- Name: idx_accounts_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_status_created ON public.accounts USING btree (status, created_at DESC);


--
-- Name: idx_admin_balance_adjustments_account_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_balance_adjustments_account_created ON public.admin_balance_adjustments USING btree (account_id, created_at DESC);


--
-- Name: idx_admin_cases_status_priority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_cases_status_priority ON public.admin_cases USING btree (status, priority, created_at DESC);


--
-- Name: idx_admin_dispute_meta_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_dispute_meta_updated ON public.admin_dispute_meta USING btree (updated_at DESC);


--
-- Name: idx_admin_enforcement_events_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_enforcement_events_created ON public.admin_enforcement_events USING btree (created_at DESC);


--
-- Name: idx_admin_entity_meta_type_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_entity_meta_type_updated ON public.admin_entity_meta USING btree (entity_type, updated_at DESC);


--
-- Name: idx_admin_entity_notes_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_entity_notes_lookup ON public.admin_entity_notes USING btree (entity_type, entity_id, created_at DESC);


--
-- Name: idx_admin_entity_tags_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_entity_tags_lookup ON public.admin_entity_tags USING btree (entity_type, entity_id, tag);


--
-- Name: idx_admin_feature_flags_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_feature_flags_updated ON public.admin_feature_flags USING btree (updated_at DESC);


--
-- Name: idx_admin_four_eyes_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_four_eyes_status_created ON public.admin_four_eyes_requests USING btree (status, created_at DESC);


--
-- Name: idx_admin_immutable_audit_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_immutable_audit_created ON public.admin_immutable_audit USING btree (created_at DESC);


--
-- Name: idx_admin_incidents_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_incidents_status_created ON public.admin_incidents USING btree (status, created_at DESC);


--
-- Name: idx_admin_notifications_status_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_notifications_status_created ON public.admin_notifications USING btree (status, created_at DESC);


--
-- Name: idx_admin_rule_violations_account_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_rule_violations_account_type ON public.admin_rule_violations USING btree (account_id, violation_type, last_detected_at DESC);


--
-- Name: idx_admin_rule_violations_status_detected; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_rule_violations_status_detected ON public.admin_rule_violations USING btree (status, last_detected_at DESC);


--
-- Name: idx_admin_rules_enabled_priority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_rules_enabled_priority ON public.admin_rules USING btree (enabled, priority);


--
-- Name: idx_admin_saved_views_owner_resource; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_saved_views_owner_resource ON public.admin_saved_views USING btree (admin_id, resource, updated_at DESC);


--
-- Name: idx_admin_scheduled_reports_enabled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_scheduled_reports_enabled ON public.admin_scheduled_reports USING btree (enabled, updated_at DESC);


--
-- Name: idx_affiliate_commissions_payout; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_affiliate_commissions_payout ON public.affiliate_commissions USING btree (payout_request_id);


--
-- Name: idx_affiliate_commissions_referred; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_affiliate_commissions_referred ON public.affiliate_commissions USING btree (referred_user_id);


--
-- Name: idx_affiliate_commissions_referrer_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_affiliate_commissions_referrer_status ON public.affiliate_commissions USING btree (referrer_user_id, status);


--
-- Name: idx_affiliate_payout_requests_affiliate_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_affiliate_payout_requests_affiliate_status ON public.affiliate_payout_requests USING btree (affiliate_user_id, status);


--
-- Name: idx_affiliate_payout_requests_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_affiliate_payout_requests_status ON public.affiliate_payout_requests USING btree (status, requested_at DESC);


--
-- Name: idx_affiliate_referrals_referrer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_affiliate_referrals_referrer ON public.affiliate_referrals USING btree (referrer_user_id);


--
-- Name: idx_affiliate_tiers_min_referrals; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_affiliate_tiers_min_referrals ON public.affiliate_commission_tiers USING btree (min_referrals) WHERE (is_active = true);


--
-- Name: idx_balance_adjustments_account_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_balance_adjustments_account_created ON public.balance_adjustments USING btree (account_id, created_at DESC);


--
-- Name: idx_balance_adjustments_competition; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_balance_adjustments_competition ON public.balance_adjustments USING btree (competition_id) WHERE (competition_id IS NOT NULL);


--
-- Name: idx_balance_adjustments_entry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_balance_adjustments_entry ON public.balance_adjustments USING btree (competition_entry_id) WHERE (competition_entry_id IS NOT NULL);


--
-- Name: idx_balance_adjustments_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_balance_adjustments_source ON public.balance_adjustments USING btree (source);


--
-- Name: idx_challenge_checkout_sessions_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_challenge_checkout_sessions_order ON public.challenge_checkout_sessions USING btree (order_id, status);


--
-- Name: idx_challenge_orders_user_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_challenge_orders_user_status ON public.challenge_orders USING btree (user_id, status, created_at DESC);


--
-- Name: idx_challenge_payments_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_challenge_payments_order ON public.challenge_payments USING btree (order_id, status);


--
-- Name: idx_competition_entries_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_competition_entries_account ON public.competition_entries USING btree (account_id);


--
-- Name: idx_competition_entries_competition_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_competition_entries_competition_status ON public.competition_entries USING btree (competition_id, status);


--
-- Name: idx_competition_prize_vouchers_competition; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_competition_prize_vouchers_competition ON public.competition_prize_vouchers USING btree (competition_id);


--
-- Name: idx_competition_prize_vouchers_user_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_competition_prize_vouchers_user_status ON public.competition_prize_vouchers USING btree (user_id, status);


--
-- Name: idx_competitions_start_end; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_competitions_start_end ON public.competitions USING btree (start_at, end_at);


--
-- Name: idx_competitions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_competitions_status ON public.competitions USING btree (status);


--
-- Name: idx_coupon_codes_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coupon_codes_active ON public.coupon_codes USING btree (is_active);


--
-- Name: idx_coupon_redemptions_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coupon_redemptions_order ON public.coupon_redemptions USING btree (order_id);


--
-- Name: idx_email_jobs_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_jobs_created ON public.email_jobs USING btree (created_at DESC);


--
-- Name: idx_email_jobs_status_schedule; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_jobs_status_schedule ON public.email_jobs USING btree (status, scheduled_for, id);


--
-- Name: idx_email_jobs_unique_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_email_jobs_unique_key ON public.email_jobs USING btree (unique_key);


--
-- Name: idx_gift_vouchers_purchaser; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gift_vouchers_purchaser ON public.gift_vouchers USING btree (purchaser_user_id);


--
-- Name: idx_gift_vouchers_recipient_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gift_vouchers_recipient_email ON public.gift_vouchers USING btree (lower(recipient_email));


--
-- Name: idx_gift_vouchers_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gift_vouchers_status ON public.gift_vouchers USING btree (status);


--
-- Name: idx_marketing_funnel_events_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketing_funnel_events_created ON public.marketing_funnel_events USING btree (event_type, created_at DESC);


--
-- Name: idx_news_cache_event_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_news_cache_event_time ON public.news_cache USING btree (event_time);


--
-- Name: idx_payouts_is_flagged; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payouts_is_flagged ON public.payouts USING btree (is_flagged) WHERE (is_flagged = true);


--
-- Name: idx_payouts_status_requested; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payouts_status_requested ON public.payouts USING btree (status, requested_at DESC);


--
-- Name: idx_pfh_instrument_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pfh_instrument_time ON public.price_feed_history USING btree (instrument, recorded_at);


--
-- Name: idx_platform_admins_status_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_admins_status_email ON public.platform_admins USING btree (status, email);


--
-- Name: idx_price_feed_history_1h_instrument_bucket; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_price_feed_history_1h_instrument_bucket ON public.price_feed_history_1h USING btree (instrument, bucket_time DESC);


--
-- Name: idx_price_feed_history_instrument_recorded_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_price_feed_history_instrument_recorded_at ON public.price_feed_history USING btree (instrument, recorded_at DESC);


--
-- Name: idx_price_feed_history_instrument_recorded_at_cover; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_price_feed_history_instrument_recorded_at_cover ON public.price_feed_history USING btree (instrument, recorded_at DESC) INCLUDE (bid, ask);


--
-- Name: idx_price_feed_source_history_1h_source_instrument_bucket; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_price_feed_source_history_1h_source_instrument_bucket ON public.price_feed_source_history_1h USING btree (source_key, instrument, bucket_time DESC);


--
-- Name: idx_price_feed_source_history_source_instrument_recorded_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_price_feed_source_history_source_instrument_recorded_at ON public.price_feed_source_history USING btree (source_key, instrument, recorded_at DESC);


--
-- Name: idx_price_feed_source_history_source_instrument_recorded_at_cov; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_price_feed_source_history_source_instrument_recorded_at_cov ON public.price_feed_source_history USING btree (source_key, instrument, recorded_at DESC) INCLUDE (bid, ask);


--
-- Name: idx_price_feed_source_prices_source_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_price_feed_source_prices_source_updated ON public.price_feed_source_prices USING btree (source_key, updated_at DESC);


--
-- Name: idx_price_feed_sources_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_price_feed_sources_status ON public.price_feed_sources USING btree (status, source_type);


--
-- Name: idx_referral_season_entries_season; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_referral_season_entries_season ON public.referral_season_entries USING btree (season_id);


--
-- Name: idx_referral_season_prize_vouchers_season; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_referral_season_prize_vouchers_season ON public.referral_season_prize_vouchers USING btree (season_id);


--
-- Name: idx_referral_season_prize_vouchers_user_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_referral_season_prize_vouchers_user_status ON public.referral_season_prize_vouchers USING btree (user_id, status);


--
-- Name: idx_referral_seasons_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_referral_seasons_status ON public.referral_seasons USING btree (status);


--
-- Name: idx_trades_closed_today; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trades_closed_today ON public.trades USING btree (account_id, close_time) WHERE ((status)::text = 'closed'::text);


--
-- Name: idx_trades_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trades_open ON public.trades USING btree (account_id) WHERE ((status)::text = 'open'::text);


--
-- Name: idx_trades_open_sltp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trades_open_sltp ON public.trades USING btree (account_id, instrument) WHERE (((status)::text = 'open'::text) AND ((stop_loss IS NOT NULL) OR (take_profit IS NOT NULL)));


--
-- Name: idx_trades_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trades_pending ON public.trades USING btree (account_id, instrument) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_user_agreement_acceptances_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_agreement_acceptances_user ON public.user_agreement_acceptances USING btree (user_id, accepted_at DESC);


--
-- Name: idx_user_notifications_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_notifications_user_created ON public.user_notifications USING btree (user_id, created_at DESC);


--
-- Name: idx_users_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_created ON public.users USING btree (created_at DESC);


--
-- Name: idx_users_id_document_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_id_document_hash ON public.users USING btree (id_document_hash) WHERE (id_document_hash IS NOT NULL);


--
-- Name: idx_users_is_bot; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_is_bot ON public.users USING btree (is_bot) WHERE (is_bot = true);


--
-- Name: login_logs_ip_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX login_logs_ip_idx ON public.login_logs USING btree (ip_address, logged_in_at);


--
-- Name: login_logs_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX login_logs_user_idx ON public.login_logs USING btree (user_id, logged_in_at DESC);


--
-- Name: payouts_account_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payouts_account_status_idx ON public.payouts USING btree (account_id, status);


--
-- Name: support_ticket_messages_ticket_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_ticket_messages_ticket_idx ON public.support_ticket_messages USING btree (ticket_id, created_at);


--
-- Name: support_tickets_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_tickets_created_idx ON public.support_tickets USING btree (created_at DESC);


--
-- Name: tenant_monthly_quotas_month_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tenant_monthly_quotas_month_idx ON public.tenant_monthly_quotas USING btree (quota_month DESC);


--
-- Name: tenant_monthly_size_quotas_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tenant_monthly_size_quotas_lookup_idx ON public.tenant_monthly_size_quotas USING btree (quota_month DESC, account_size);


--
-- Name: trade_logs_ip_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trade_logs_ip_idx ON public.trade_logs USING btree (ip_address, logged_at);


--
-- Name: trade_logs_logged_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trade_logs_logged_at_idx ON public.trade_logs USING btree (logged_at);


--
-- Name: trades_account_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trades_account_status_idx ON public.trades USING btree (account_id, status);


--
-- Name: trades_oco_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trades_oco_group_idx ON public.trades USING btree (oco_group_id) WHERE (oco_group_id IS NOT NULL);


--
-- Name: trades_open_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trades_open_time_idx ON public.trades USING btree (open_time);


--
-- Name: trades_open_with_levels_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trades_open_with_levels_idx ON public.trades USING btree (account_id) WHERE (((status)::text = 'open'::text) AND ((stop_loss IS NOT NULL) OR (take_profit IS NOT NULL)));


--
-- Name: trades_status_open_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trades_status_open_time_idx ON public.trades USING btree (status, open_time);


--
-- Name: uq_affiliate_commissions_order; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_affiliate_commissions_order ON public.affiliate_commissions USING btree (order_id) WHERE (order_id IS NOT NULL);


--
-- Name: uq_affiliate_referrals_referred_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_affiliate_referrals_referred_user ON public.affiliate_referrals USING btree (referred_user_id);


--
-- Name: uq_challenge_models_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_challenge_models_slug ON public.challenge_models USING btree (slug);


--
-- Name: uq_challenge_payments_order; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_challenge_payments_order ON public.challenge_payments USING btree (order_id);


--
-- Name: uq_competition_entry_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_competition_entry_user ON public.competition_entries USING btree (competition_id, user_id);


--
-- Name: uq_coupon_redemptions_coupon_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_coupon_redemptions_coupon_user ON public.coupon_redemptions USING btree (coupon_id, user_id);


--
-- Name: users_trader_uid_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_trader_uid_uq ON public.users USING btree (trader_uid);


--
-- Name: accounts accounts_upd_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER accounts_upd_trigger BEFORE UPDATE ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: affiliate_commission_tiers affiliate_commission_tiers_upd_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER affiliate_commission_tiers_upd_trigger BEFORE UPDATE ON public.affiliate_commission_tiers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: affiliate_commissions affiliate_commissions_upd_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER affiliate_commissions_upd_trigger BEFORE UPDATE ON public.affiliate_commissions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: affiliate_payout_requests affiliate_payout_requests_upd_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER affiliate_payout_requests_upd_trigger BEFORE UPDATE ON public.affiliate_payout_requests FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: competition_entries competition_entries_upd_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER competition_entries_upd_trigger BEFORE UPDATE ON public.competition_entries FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: competition_prize_vouchers competition_prize_vouchers_upd_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER competition_prize_vouchers_upd_trigger BEFORE UPDATE ON public.competition_prize_vouchers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: competitions competitions_upd_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER competitions_upd_trigger BEFORE UPDATE ON public.competitions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: coupon_codes coupon_codes_upd_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER coupon_codes_upd_trigger BEFORE UPDATE ON public.coupon_codes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: gift_vouchers gift_vouchers_upd_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER gift_vouchers_upd_trigger BEFORE UPDATE ON public.gift_vouchers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: referral_season_entries referral_season_entries_upd_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER referral_season_entries_upd_trigger BEFORE UPDATE ON public.referral_season_entries FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: referral_season_prize_vouchers referral_season_prize_vouchers_upd_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER referral_season_prize_vouchers_upd_trigger BEFORE UPDATE ON public.referral_season_prize_vouchers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: referral_seasons referral_seasons_upd_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER referral_seasons_upd_trigger BEFORE UPDATE ON public.referral_seasons FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ab_experiment_events ab_experiment_events_experiment_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ab_experiment_events
    ADD CONSTRAINT ab_experiment_events_experiment_key_fkey FOREIGN KEY (experiment_key) REFERENCES public.ab_experiments(key) ON DELETE CASCADE;


--
-- Name: account_link_evidence account_link_evidence_cluster_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_link_evidence
    ADD CONSTRAINT account_link_evidence_cluster_id_fkey FOREIGN KEY (cluster_id) REFERENCES public.account_link_clusters(id) ON DELETE CASCADE;


--
-- Name: accounts accounts_challenge_model_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_challenge_model_id_fkey FOREIGN KEY (challenge_model_id) REFERENCES public.challenge_models(id);


--
-- Name: accounts accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: admin_enforcement_events admin_enforcement_events_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_enforcement_events
    ADD CONSTRAINT admin_enforcement_events_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.admin_rules(id) ON DELETE SET NULL;


--
-- Name: admin_entity_meta admin_entity_meta_linked_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_entity_meta
    ADD CONSTRAINT admin_entity_meta_linked_case_id_fkey FOREIGN KEY (linked_case_id) REFERENCES public.admin_cases(id) ON DELETE SET NULL;


--
-- Name: affiliate_commissions affiliate_commissions_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_commissions
    ADD CONSTRAINT affiliate_commissions_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.challenge_orders(id) ON DELETE SET NULL;


--
-- Name: affiliate_commissions affiliate_commissions_referral_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_commissions
    ADD CONSTRAINT affiliate_commissions_referral_id_fkey FOREIGN KEY (referral_id) REFERENCES public.affiliate_referrals(id) ON DELETE SET NULL;


--
-- Name: affiliate_commissions affiliate_commissions_referred_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_commissions
    ADD CONSTRAINT affiliate_commissions_referred_user_id_fkey FOREIGN KEY (referred_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: affiliate_commissions affiliate_commissions_referrer_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_commissions
    ADD CONSTRAINT affiliate_commissions_referrer_user_id_fkey FOREIGN KEY (referrer_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: affiliate_payout_requests affiliate_payout_requests_affiliate_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_payout_requests
    ADD CONSTRAINT affiliate_payout_requests_affiliate_user_id_fkey FOREIGN KEY (affiliate_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: affiliate_referrals affiliate_referrals_referred_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_referrals
    ADD CONSTRAINT affiliate_referrals_referred_user_id_fkey FOREIGN KEY (referred_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: affiliate_referrals affiliate_referrals_referrer_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.affiliate_referrals
    ADD CONSTRAINT affiliate_referrals_referrer_user_id_fkey FOREIGN KEY (referrer_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: balance_adjustments balance_adjustments_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.balance_adjustments
    ADD CONSTRAINT balance_adjustments_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: balance_adjustments balance_adjustments_competition_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.balance_adjustments
    ADD CONSTRAINT balance_adjustments_competition_entry_id_fkey FOREIGN KEY (competition_entry_id) REFERENCES public.competition_entries(id) ON DELETE SET NULL;


--
-- Name: balance_adjustments balance_adjustments_competition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.balance_adjustments
    ADD CONSTRAINT balance_adjustments_competition_id_fkey FOREIGN KEY (competition_id) REFERENCES public.competitions(id) ON DELETE SET NULL;


--
-- Name: balance_adjustments balance_adjustments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.balance_adjustments
    ADD CONSTRAINT balance_adjustments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: challenge_checkout_sessions challenge_checkout_sessions_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.challenge_checkout_sessions
    ADD CONSTRAINT challenge_checkout_sessions_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.challenge_orders(id) ON DELETE CASCADE;


--
-- Name: challenge_model_pricing challenge_model_pricing_challenge_model_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.challenge_model_pricing
    ADD CONSTRAINT challenge_model_pricing_challenge_model_id_fkey FOREIGN KEY (challenge_model_id) REFERENCES public.challenge_models(id) ON DELETE CASCADE;


--
-- Name: challenge_payments challenge_payments_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.challenge_payments
    ADD CONSTRAINT challenge_payments_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.challenge_orders(id) ON DELETE CASCADE;


--
-- Name: chat_messages chat_messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.chat_conversations(id) ON DELETE CASCADE;


--
-- Name: competition_entries competition_entries_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competition_entries
    ADD CONSTRAINT competition_entries_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);


--
-- Name: competition_entries competition_entries_competition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competition_entries
    ADD CONSTRAINT competition_entries_competition_id_fkey FOREIGN KEY (competition_id) REFERENCES public.competitions(id) ON DELETE CASCADE;


--
-- Name: competition_entries competition_entries_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competition_entries
    ADD CONSTRAINT competition_entries_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: competition_prize_vouchers competition_prize_vouchers_competition_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competition_prize_vouchers
    ADD CONSTRAINT competition_prize_vouchers_competition_entry_id_fkey FOREIGN KEY (competition_entry_id) REFERENCES public.competition_entries(id) ON DELETE SET NULL;


--
-- Name: competition_prize_vouchers competition_prize_vouchers_competition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competition_prize_vouchers
    ADD CONSTRAINT competition_prize_vouchers_competition_id_fkey FOREIGN KEY (competition_id) REFERENCES public.competitions(id) ON DELETE CASCADE;


--
-- Name: competition_prize_vouchers competition_prize_vouchers_redeemed_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competition_prize_vouchers
    ADD CONSTRAINT competition_prize_vouchers_redeemed_order_id_fkey FOREIGN KEY (redeemed_order_id) REFERENCES public.challenge_orders(id) ON DELETE SET NULL;


--
-- Name: competition_prize_vouchers competition_prize_vouchers_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competition_prize_vouchers
    ADD CONSTRAINT competition_prize_vouchers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: competitions competitions_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competitions
    ADD CONSTRAINT competitions_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.competitions(id);


--
-- Name: coupon_redemptions coupon_redemptions_coupon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupon_redemptions
    ADD CONSTRAINT coupon_redemptions_coupon_id_fkey FOREIGN KEY (coupon_id) REFERENCES public.coupon_codes(id) ON DELETE CASCADE;


--
-- Name: coupon_redemptions coupon_redemptions_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupon_redemptions
    ADD CONSTRAINT coupon_redemptions_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.challenge_orders(id) ON DELETE SET NULL;


--
-- Name: coupon_redemptions coupon_redemptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupon_redemptions
    ADD CONSTRAINT coupon_redemptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: gift_vouchers gift_vouchers_claimed_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gift_vouchers
    ADD CONSTRAINT gift_vouchers_claimed_order_id_fkey FOREIGN KEY (claimed_order_id) REFERENCES public.challenge_orders(id) ON DELETE SET NULL;


--
-- Name: gift_vouchers gift_vouchers_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gift_vouchers
    ADD CONSTRAINT gift_vouchers_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.challenge_orders(id) ON DELETE SET NULL;


--
-- Name: gift_vouchers gift_vouchers_purchaser_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gift_vouchers
    ADD CONSTRAINT gift_vouchers_purchaser_user_id_fkey FOREIGN KEY (purchaser_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: gift_vouchers gift_vouchers_recipient_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gift_vouchers
    ADD CONSTRAINT gift_vouchers_recipient_user_id_fkey FOREIGN KEY (recipient_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: identity_signals identity_signals_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.identity_signals
    ADD CONSTRAINT identity_signals_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: payouts payouts_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payouts
    ADD CONSTRAINT payouts_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);


--
-- Name: payouts payouts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payouts
    ADD CONSTRAINT payouts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: price_feed_source_history_1h price_feed_source_history_1h_source_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_feed_source_history_1h
    ADD CONSTRAINT price_feed_source_history_1h_source_key_fkey FOREIGN KEY (source_key) REFERENCES public.price_feed_sources(source_key) ON DELETE CASCADE;


--
-- Name: price_feed_source_history price_feed_source_history_source_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_feed_source_history
    ADD CONSTRAINT price_feed_source_history_source_key_fkey FOREIGN KEY (source_key) REFERENCES public.price_feed_sources(source_key) ON DELETE CASCADE;


--
-- Name: price_feed_source_prices price_feed_source_prices_source_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_feed_source_prices
    ADD CONSTRAINT price_feed_source_prices_source_key_fkey FOREIGN KEY (source_key) REFERENCES public.price_feed_sources(source_key) ON DELETE CASCADE;


--
-- Name: referral_season_entries referral_season_entries_referrer_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_season_entries
    ADD CONSTRAINT referral_season_entries_referrer_user_id_fkey FOREIGN KEY (referrer_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: referral_season_entries referral_season_entries_season_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_season_entries
    ADD CONSTRAINT referral_season_entries_season_id_fkey FOREIGN KEY (season_id) REFERENCES public.referral_seasons(id) ON DELETE CASCADE;


--
-- Name: referral_season_prize_vouchers referral_season_prize_vouchers_redeemed_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_season_prize_vouchers
    ADD CONSTRAINT referral_season_prize_vouchers_redeemed_order_id_fkey FOREIGN KEY (redeemed_order_id) REFERENCES public.challenge_orders(id) ON DELETE SET NULL;


--
-- Name: referral_season_prize_vouchers referral_season_prize_vouchers_season_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_season_prize_vouchers
    ADD CONSTRAINT referral_season_prize_vouchers_season_entry_id_fkey FOREIGN KEY (season_entry_id) REFERENCES public.referral_season_entries(id) ON DELETE SET NULL;


--
-- Name: referral_season_prize_vouchers referral_season_prize_vouchers_season_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_season_prize_vouchers
    ADD CONSTRAINT referral_season_prize_vouchers_season_id_fkey FOREIGN KEY (season_id) REFERENCES public.referral_seasons(id) ON DELETE CASCADE;


--
-- Name: referral_season_prize_vouchers referral_season_prize_vouchers_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referral_season_prize_vouchers
    ADD CONSTRAINT referral_season_prize_vouchers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: support_ticket_messages support_ticket_messages_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_ticket_messages
    ADD CONSTRAINT support_ticket_messages_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.support_tickets(id) ON DELETE CASCADE;


--
-- Name: trades trades_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trades
    ADD CONSTRAINT trades_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);


--
-- Name: user_agreement_acceptances user_agreement_acceptances_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_agreement_acceptances
    ADD CONSTRAINT user_agreement_acceptances_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_notifications user_notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_notifications
    ADD CONSTRAINT user_notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


