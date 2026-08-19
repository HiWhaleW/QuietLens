-- QuietLens Stage 2 / S2-T02
-- Creates only the reviewer authorization and append-only audit storage boundary.
-- It does not create a reviewer, enable the Worker API, or insert a review result.

create table if not exists public.quietlens_reviewer_grants (
  auth_user_id uuid primary key references auth.users(id) on delete restrict,
  reviewer_id text not null unique check (reviewer_id ~ '^reviewer-[a-z0-9]+(?:-[a-z0-9]+)*$'),
  roles text[] not null check (
    cardinality(roles) > 0
    and roles <@ array[
      'evidence_reviewer',
      'evidence_publisher',
      'evidence_rollback_operator',
      'evidence_auditor'
    ]::text[]
  ),
  scope_ids text[] not null check (cardinality(scope_ids) > 0),
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.quietlens_evidence_review_ledger_heads (
  scope_id text primary key check (scope_id ~ '^evidence-[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$'),
  version bigint not null default 0 check (version >= 0),
  head_entry_sha256 text null check (head_entry_sha256 is null or head_entry_sha256 ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz not null default now()
);

create table if not exists public.quietlens_evidence_review_audit_entries (
  scope_id text not null references public.quietlens_evidence_review_ledger_heads(scope_id) on delete restrict,
  sequence bigint not null check (sequence >= 1),
  event_id text not null check (event_id ~ '^audit-[a-f0-9]{16}$'),
  command_id text not null check (command_id ~ '^command-[a-f0-9]{16}$'),
  entry_sha256 text not null check (entry_sha256 ~ '^[a-f0-9]{64}$'),
  entry jsonb not null check (jsonb_typeof(entry) = 'object'),
  created_at timestamptz not null default now(),
  primary key (scope_id, sequence),
  unique (scope_id, event_id),
  unique (scope_id, command_id),
  unique (scope_id, entry_sha256)
);

alter table public.quietlens_reviewer_grants enable row level security;
alter table public.quietlens_evidence_review_ledger_heads enable row level security;
alter table public.quietlens_evidence_review_audit_entries enable row level security;

revoke all on public.quietlens_reviewer_grants from anon, authenticated;
revoke all on public.quietlens_evidence_review_ledger_heads from anon, authenticated;
revoke all on public.quietlens_evidence_review_audit_entries from anon, authenticated;
grant select on public.quietlens_reviewer_grants to service_role;
grant select on public.quietlens_evidence_review_ledger_heads to service_role;
grant select on public.quietlens_evidence_review_audit_entries to service_role;

create or replace function public.quietlens_append_evidence_review_audit_entry(
  p_scope_id text,
  p_expected_version bigint,
  p_entry jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_version bigint;
  current_head text;
  next_sequence bigint;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'QUIETLENS_SERVICE_ROLE_REQUIRED';
  end if;
  if p_scope_id !~ '^evidence-[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$'
    or p_expected_version < 0
    or jsonb_typeof(p_entry) <> 'object'
    or p_entry->>'schema_version' <> '1.1.0'
    or p_entry->>'review_context' <> 'production'
    or p_entry->>'scope_id' <> p_scope_id
    or (p_entry->>'sequence')::bigint <> p_expected_version + 1
    or p_entry->>'event_id' !~ '^audit-[a-f0-9]{16}$'
    or p_entry->>'command_id' !~ '^command-[a-f0-9]{16}$'
    or p_entry->>'entry_sha256' !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'EVIDENCE_AUDIT_ENTRY_INVALID';
  end if;

  insert into public.quietlens_evidence_review_ledger_heads(scope_id)
  values (p_scope_id)
  on conflict (scope_id) do nothing;

  select version, head_entry_sha256
    into current_version, current_head
    from public.quietlens_evidence_review_ledger_heads
    where scope_id = p_scope_id
    for update;

  if current_version <> p_expected_version then
    raise exception using errcode = 'P0001', message = 'EVIDENCE_AUDIT_CONCURRENT_WRITE';
  end if;
  if (p_entry->>'previous_entry_sha256') is distinct from current_head then
    raise exception using errcode = '22023', message = 'EVIDENCE_AUDIT_PREVIOUS_HASH_INVALID';
  end if;

  next_sequence := current_version + 1;
  insert into public.quietlens_evidence_review_audit_entries(
    scope_id,
    sequence,
    event_id,
    command_id,
    entry_sha256,
    entry
  ) values (
    p_scope_id,
    next_sequence,
    p_entry->>'event_id',
    p_entry->>'command_id',
    p_entry->>'entry_sha256',
    p_entry
  );

  update public.quietlens_evidence_review_ledger_heads
    set version = next_sequence,
        head_entry_sha256 = p_entry->>'entry_sha256',
        updated_at = now()
    where scope_id = p_scope_id;

  return jsonb_build_object(
    'scope_id', p_scope_id,
    'version', next_sequence,
    'head_entry_sha256', p_entry->>'entry_sha256'
  );
end;
$$;

revoke all on function public.quietlens_append_evidence_review_audit_entry(text, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.quietlens_append_evidence_review_audit_entry(text, bigint, jsonb) to service_role;

comment on table public.quietlens_reviewer_grants is
  'Server-only mapping from Supabase Auth users to opaque QuietLens Evidence roles and scopes.';
comment on table public.quietlens_evidence_review_audit_entries is
  'Append-only QuietLens Evidence review audit entries; application verifies the SHA-256 chain on every read and append.';
