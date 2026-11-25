-- iPaidThat archive and reviewed client links. Existing workspace records are retained.
begin;

create table public.ipaid_imports (
  id text primary key check (id ~ '^[0-9a-f]{64}$'),
  filename text not null,
  expected_clients integer not null check (expected_clients between 1 and 25000),
  expected_documents integer not null check (expected_documents between 0 and 50000),
  imported_by uuid references auth.users(id) on delete set null,
  imported_at timestamptz not null default now(),
  completed_at timestamptz
);
create table public.ipaid_client_history (
  batch_id text not null references public.ipaid_imports(id),
  source_id text not null,
  name text not null,
  email text,
  phone text,
  address text,
  details jsonb not null,
  review_reason text,
  client_id uuid references public.clients(id),
  search_text text generated always as (source_id || ' ' || name || ' ' || coalesce(email,'') || ' ' || coalesce(phone,'')) stored,
  primary key (batch_id,source_id)
);
create table public.ipaid_document_history (
  batch_id text not null,
  source_row integer not null,
  source_id text not null,
  client_name text not null,
  kind text not null,
  number text not null,
  label text,
  status text,
  issued_on date,
  total_ex_vat numeric,
  vat numeric,
  total_inc_vat numeric,
  paid boolean,
  overdue boolean,
  details jsonb not null,
  search_text text generated always as (number || ' ' || client_name || ' ' || coalesce(label,'') || ' ' || coalesce(status,'')) stored,
  primary key (batch_id,source_row),
  foreign key (batch_id,source_id) references public.ipaid_client_history(batch_id,source_id)
);
create index ipaid_document_client on public.ipaid_document_history(batch_id,source_id);
create index ipaid_document_date on public.ipaid_document_history(issued_on desc);
create index ipaid_history_client on public.ipaid_client_history(client_id);

alter table public.ipaid_imports enable row level security;
alter table public.ipaid_client_history enable row level security;
alter table public.ipaid_document_history enable row level security;

revoke all on public.ipaid_imports, public.ipaid_client_history, public.ipaid_document_history from public,anon,authenticated;
grant select on public.ipaid_imports, public.ipaid_client_history, public.ipaid_document_history to authenticated;

create policy staff_archive_read on public.ipaid_imports
  for select to authenticated using (public.is_staff());
create policy staff_archive_read on public.ipaid_client_history
  for select to authenticated using (public.is_staff());
create policy staff_archive_read on public.ipaid_document_history
  for select to authenticated using (public.is_staff());

create function public.ipaid_client_key(value text) returns text language sql immutable set search_path = '' as $$
  select lower(trim(regexp_replace(coalesce(value,''),'[[:space:]]+',' ','g')))
$$;

create function public.workspace_ipaid_import(action text,payload jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  batch public.ipaid_imports;
  source public.ipaid_client_history;
  batch_key text := payload->>'batch_id';
  chosen_client uuid;
begin
  if not public.is_staff() then raise exception 'Staff access required' using errcode='42501'; end if;

  if action='start' then
    insert into public.ipaid_imports(id,filename,expected_clients,expected_documents,imported_by)
    values(batch_key,left(payload->>'filename',500),(payload->>'clients')::integer,(payload->>'documents')::integer,auth.uid())
    on conflict(id) do nothing;
    return;
  end if;

  select * into strict batch from public.ipaid_imports where id=batch_key for update;
  if action in ('clients','documents') then
    if batch.completed_at is not null then return; end if;
    if jsonb_typeof(payload->'rows') is distinct from 'array' or jsonb_array_length(payload->'rows') not between 1 and 200 then
      raise exception 'Use 1 to 200 rows per import request';
    end if;
  end if;

  if action='clients' then
    insert into public.ipaid_client_history(batch_id,source_id,name,email,phone,address,details,review_reason)
    select batch.id,x.source_id,x.name,x.email,x.phone,x.address,x.details,x.review_reason
    from jsonb_to_recordset(payload->'rows') as x(source_id text,name text,email text,phone text,address text,details jsonb,review_reason text)
    on conflict(batch_id,source_id) do nothing;
  elsif action='documents' then
    insert into public.ipaid_document_history(batch_id,source_row,source_id,client_name,kind,number,label,status,issued_on,total_ex_vat,vat,total_inc_vat,paid,overdue,details)
    select batch.id,x.source_row,x.source_id,x.client_name,x.kind,x.number,x.label,x.status,x.issued_on,x.total_ex_vat,x.vat,x.total_inc_vat,x.paid,x.overdue,x.details
    from jsonb_to_recordset(payload->'rows') as x(source_row int,source_id text,client_name text,kind text,number text,label text,status text,issued_on date,total_ex_vat numeric,vat numeric,total_inc_vat numeric,paid boolean,overdue boolean,details jsonb)
    on conflict(batch_id,source_row) do nothing;
  elsif action='finish' then
    if batch.completed_at is not null then return; end if;
    if (select count(*) from public.ipaid_client_history where batch_id=batch.id) <> batch.expected_clients
      or (select count(*) from public.ipaid_document_history where batch_id=batch.id) <> batch.expected_documents then
      raise exception 'Import incomplete. Upload the same workbook again to resume';
    end if;
    -- Serialize matching and new client insertion with edits to the working directory.
    lock table public.clients in share row exclusive mode;
    with candidates as (
      select h.source_id, array_agg(c.id) as ids
      from public.ipaid_client_history h join public.clients c
        on lower(trim(c.email))=lower(trim(h.email))
      where h.batch_id=batch.id and h.review_reason is null and h.email is not null
      group by h.source_id
    )
    update public.ipaid_client_history h set client_id=(m.ids)[1]
    from candidates m join public.clients c on c.id=(m.ids)[1]
    where h.batch_id=batch.id and h.source_id=m.source_id and cardinality(m.ids)=1
      and public.ipaid_client_key(h.name)=public.ipaid_client_key(c.name);
    -- Missing contact data and any existing name/email collision need review.
    update public.ipaid_client_history h set review_reason=coalesce(review_reason,
      case when h.email is null then 'Missing primary email'
        else 'Possible match in the workspace directory' end)
    where h.batch_id=batch.id and h.client_id is null and (h.email is null or exists (
      select 1 from public.clients c where lower(trim(c.email))=lower(trim(h.email))
        or public.ipaid_client_key(c.name)=public.ipaid_client_key(h.name)
    ));
    with created as (
      insert into public.clients(name,email,phone,billing_address,legacy_id,attributes)
      select name,email,phone,address,'ipaid:' || batch.id || ':' || source_id,
        jsonb_build_object('ipaid_source_id',source_id,'ipaid_batch_id',batch.id)
      from public.ipaid_client_history where batch_id=batch.id and client_id is null and review_reason is null
      returning id,attributes
    )
    update public.ipaid_client_history h set client_id=c.id from created c
    where h.batch_id=batch.id and h.source_id=c.attributes->>'ipaid_source_id';
    update public.ipaid_imports set completed_at=now() where id=batch.id;
  elsif action in ('link_client','create_client') then
    if batch.completed_at is null then raise exception 'Finish importing the workbook first'; end if;
    select * into strict source from public.ipaid_client_history
      where batch_id=batch.id and source_id=payload->>'source_id' for update;
    if source.client_id is not null then raise exception 'This source contact is already linked'; end if;
    if action='create_client' then
      insert into public.clients(name,email,phone,billing_address,legacy_id,attributes)
      values(source.name,source.email,source.phone,source.address,'ipaid:' || batch.id || ':' || source.source_id,
        jsonb_build_object('ipaid_source_id',source.source_id,'ipaid_batch_id',batch.id))
      returning id into chosen_client;
    else
      chosen_client := (payload->>'client_id')::uuid;
      if chosen_client is null or not exists(select 1 from public.clients where id=chosen_client) then
        raise exception 'Choose an existing workspace client';
      end if;
    end if;
    update public.ipaid_client_history set client_id=chosen_client
    where batch_id=batch.id and source_id=source.source_id;
    insert into public.audit_events(actor,action,record_id,details)
    values(auth.uid(),'ipaid_' || action,chosen_client,jsonb_build_object('batch',batch.id,'source_id',source.source_id));
  else
    raise exception 'Unknown iPaidThat import action';
  end if;
end;
$$;

revoke all on function public.workspace_ipaid_import(text,jsonb) from public,anon;
grant execute on function public.workspace_ipaid_import(text,jsonb) to authenticated;
commit;
