-- Run as the database owner in a new Supabase project.
begin;
create table public.staff_members (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null
);
create function public.is_staff() returns boolean language sql stable security definer
set search_path = '' as $$ select exists(select 1 from public.staff_members where id = auth.uid()) $$;
revoke all on function public.is_staff() from public;
grant execute on function public.is_staff() to authenticated;

create table public.clients (
  id uuid primary key default gen_random_uuid(), name text not null check(length(trim(name)) > 0),
  email text, phone text, billing_address text, notes text, legacy_id text unique
);
create table public.vessels (
  id uuid primary key default gen_random_uuid(), name text not null check(length(trim(name)) > 0),
  client_id uuid references public.clients(id), framework text not null default 'MSN', flag_state text,
  crew integer not null check(crew between 1 and 60), loyalty boolean not null default false, legacy_id text unique
);
create table public.vendors (
  id uuid primary key default gen_random_uuid(), name text not null check(length(trim(name)) > 0),
  email text, phone text, notes text, legacy_id text unique
);
create table public.vendor_products (
  id uuid primary key default gen_random_uuid(), vendor_id uuid references public.vendors(id),
  description text not null, sku text, pack_description text, price numeric(14,4) check(price >= 0), legacy_id text unique
);
create table public.kit_templates (
  id uuid primary key default gen_random_uuid(), name text not null, framework text not null,
  category text not null, version text not null, published boolean not null default false,
  source_hash text, unique(framework, category, version)
);
create table public.template_items (
  id uuid primary key default gen_random_uuid(), template_id uuid not null references public.kit_templates(id),
  source_code text not null, description text not null, location text not null default '',
  pack_description text not null default '', baseline_packs numeric not null check(baseline_packs >= 0),
  scaling text not null check(scaling in ('fixed','band')), unit_price numeric(14,4) not null check(unit_price >= 0),
  attributes jsonb not null default '{}', unique(template_id, source_code)
);
create table public.kit_checks (
  id uuid primary key default gen_random_uuid(), vessel_id uuid not null references public.vessels(id),
  client_id uuid not null references public.clients(id), template_id uuid not null references public.kit_templates(id),
  check_date date not null, valid_until date not null, crew integer not null check(crew between 1 and 60),
  job_type text not null check(job_type in ('Routine Refill','Category Swap','Restructure','New Build')),
  status text not null default 'assessing' check(status in ('assessing','awaiting_approval','packing','complete')),
  notes text not null default '', assessment_fee numeric(14,2) not null default 0 check(assessment_fee >= 0),
  loyalty boolean not null default false, created_at timestamptz not null default now(),
  created_by uuid references auth.users(id), check(valid_until > check_date)
);
create table public.check_items (
  id uuid primary key default gen_random_uuid(), check_id uuid not null references public.kit_checks(id),
  template_item_id uuid not null references public.template_items(id), source_code text not null,
  description text not null, location text not null default '', pack_description text not null default '',
  required_packs numeric not null check(required_packs >= 0), unit_price numeric(14,4) not null check(unit_price >= 0),
  assessment_state text not null default 'unreviewed' check(assessment_state in ('unreviewed','reviewed','not_applicable')),
  unique(check_id, template_item_id)
);
create table public.batches (
  id uuid primary key default gen_random_uuid(), check_item_id uuid not null references public.check_items(id),
  kind text not null check(kind in ('kept','removed','supplied')), quantity integer not null check(quantity > 0),
  expiry date, no_expiry boolean not null default false, notes text not null default '',
  created_at timestamptz not null default now(), created_by uuid references auth.users(id),
  check((no_expiry and expiry is null) or (not no_expiry and expiry is not null)),
  check(expiry is null or extract(day from expiry) = 1)
);
create table public.quotes (
  id uuid primary key default gen_random_uuid(), check_id uuid not null references public.kit_checks(id),
  status text not null default 'draft' check(status in ('draft','approved')),
  subtotal numeric(14,2) not null check(subtotal >= 0), lines jsonb not null,
  created_at timestamptz not null default now(), approved_at timestamptz, approved_by uuid references auth.users(id)
);
create unique index one_approved_quote on public.quotes(check_id) where status = 'approved';
create table public.audit_events (
  id bigint generated always as identity primary key, actor uuid references auth.users(id),
  action text not null, record_id uuid, created_at timestamptz not null default now()
);
create index on public.vessels(client_id);
create index on public.vendor_products(vendor_id);
create index on public.template_items(template_id);
create index on public.kit_checks(vessel_id);
create index on public.kit_checks(client_id);
create index on public.kit_checks(template_id);
create index on public.check_items(check_id);
create index on public.batches(check_item_id);
create index on public.quotes(check_id);

do $$ declare t text; begin
  foreach t in array array['staff_members','clients','vessels','vendors','vendor_products','kit_templates',
    'template_items','kit_checks','check_items','batches','quotes','audit_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy staff_read on public.%I for select to authenticated using (public.is_staff())', t);
  end loop;
end $$;

create view public.line_quantities with (security_invoker = true) as
select i.id, i.check_id, i.assessment_state,
  coalesce(sum(b.quantity) filter(where b.kind = 'kept'),0) as kept,
  coalesce(sum(b.quantity) filter(where b.kind = 'supplied'),0) as supplied,
  case when i.assessment_state = 'not_applicable' then 0 else greatest(0,i.required_packs - coalesce(sum(b.quantity) filter(where b.kind = 'kept'),0)) end as needed
from public.check_items i left join public.batches b on b.check_item_id = i.id group by i.id;
revoke all on public.line_quantities from public, anon;
grant select on public.line_quantities to authenticated;

-- A single transaction per action. Staff cannot bypass workflow by directly updating tables.
create function public.workspace_command(action text, payload jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  result uuid; c public.kit_checks; i public.check_items; v public.vessels;
  t public.kit_templates; q public.quotes; quantity integer; expiry date; no_expiry boolean;
  batch_kind text; kept numeric; supplied numeric; needed numeric; lines jsonb; subtotal numeric;
  band integer; requested_check uuid; name_value text;
begin
  if not public.is_staff() then raise exception 'Staff access required' using errcode = '42501'; end if;
  if action in ('create_client','create_vendor') then
    name_value := trim(payload->>'name');
    if coalesce(name_value,'') = '' then raise exception 'Name is required'; end if;
    if action = 'create_client' then
      insert into public.clients(name,email,phone,billing_address,notes) values(name_value,nullif(payload->>'email',''),nullif(payload->>'phone',''),nullif(payload->>'billing_address',''),nullif(payload->>'notes','')) returning id into result;
    else
      insert into public.vendors(name,email,phone,notes) values(name_value,nullif(payload->>'email',''),nullif(payload->>'phone',''),nullif(payload->>'notes','')) returning id into result;
    end if;
  elsif action = 'create_vessel' then
    insert into public.vessels(name,client_id,framework,flag_state,crew,loyalty)
    values(trim(payload->>'name'),(payload->>'client_id')::uuid,payload->>'framework',nullif(payload->>'flag_state',''),(payload->>'crew')::integer,coalesce((payload->>'loyalty')::boolean,false)) returning id into result;
  elsif action = 'create_vendor_product' then
    if coalesce(trim(payload->>'description'),'') = '' then raise exception 'Description required'; end if;
    insert into public.vendor_products(vendor_id,description,sku,pack_description,price)
    values((payload->>'vendor_id')::uuid,payload->>'description',payload->>'sku',payload->>'pack_description',nullif(payload->>'price','')::numeric) returning id into result;
  elsif action = 'create_check' then
    select * into strict v from public.vessels where id = (payload->>'vessel_id')::uuid;
    select * into strict t from public.kit_templates where id = (payload->>'template_id')::uuid and published;
    if v.client_id is null then raise exception 'Assign a client to the vessel first'; end if;
    if t.framework <> v.framework and t.framework <> 'ALL' then raise exception 'Template does not match vessel framework'; end if;
    if not exists(select 1 from public.template_items where template_id=t.id) then raise exception 'Template has no items'; end if;
    select min(x) into band from unnest(array[10,20,30,40,60]) x where x >= v.crew;
    insert into public.kit_checks(vessel_id,client_id,template_id,check_date,valid_until,crew,job_type,loyalty,created_by)
    values(v.id,v.client_id,t.id,(payload->>'check_date')::date,((payload->>'check_date')::date + interval '12 months')::date,v.crew,payload->>'job_type',v.loyalty,auth.uid()) returning id into result;
    insert into public.check_items(check_id,template_item_id,source_code,description,location,pack_description,required_packs,unit_price)
    select result,id,source_code,description,location,pack_description,
      case when scaling = 'fixed' then baseline_packs else round(baseline_packs * band / 10) end,unit_price from public.template_items where template_id=t.id;
  else
    if action in ('add_batch','mark_assessed') then
      select check_id into strict requested_check from public.check_items where id=(payload->>'item_id')::uuid;
    else requested_check := (payload->>'check_id')::uuid; end if;
    select * into strict c from public.kit_checks where id=requested_check for update;
    result := c.id;
    if action in ('add_batch','mark_assessed') then
      select * into strict i from public.check_items where id=(payload->>'item_id')::uuid;
      if action='mark_assessed' then
        if c.status <> 'assessing' then raise exception 'Assessment is locked after quoting'; end if;
        if (payload->>'state') not in ('reviewed','not_applicable') then raise exception 'Invalid assessment state'; end if;
        if payload->>'state' = 'not_applicable' and exists(select 1 from public.batches where check_item_id=i.id and kind='kept') then raise exception 'Cannot exclude an item with retained stock'; end if;
        update public.check_items set assessment_state=payload->>'state' where id=i.id;
      else
        quantity := (payload->>'quantity')::integer;
        if quantity is null or quantity <= 0 then raise exception 'Positive whole pack quantity required'; end if;
        no_expiry := coalesce((payload->>'no_expiry')::boolean,false);
        expiry := nullif(payload->>'expiry','')::date;
        if (no_expiry and expiry is not null) or (not no_expiry and expiry is null) then raise exception 'Choose expiry or no expiry'; end if;
        if c.status='assessing' then
          if i.assessment_state='not_applicable' then raise exception 'Item is not applicable'; end if;
          batch_kind := case when no_expiry or expiry + interval '1 month' > c.valid_until then 'kept' else 'removed' end;
        elsif c.status='packing' then
          if i.assessment_state <> 'reviewed' then raise exception 'Item has not been assessed'; end if;
          if not no_expiry and expiry + interval '1 month' <= c.valid_until - interval '1 month' then raise exception 'Supplied batch has insufficient expiry coverage'; end if;
          select l.kept,l.supplied,l.needed into kept,supplied,needed from public.line_quantities l where id=i.id;
          if supplied + quantity > needed then raise exception 'Supply exceeds outstanding quantity'; end if;
          batch_kind := 'supplied';
        else raise exception 'Batch entry is locked at this stage'; end if;
        insert into public.batches(check_item_id,kind,quantity,expiry,no_expiry,notes,created_by)
        values(i.id,batch_kind,quantity,expiry,no_expiry,coalesce(payload->>'notes',''),auth.uid());
      end if;
    elsif action='create_quote' then
      if c.status <> 'assessing' then raise exception 'Quote already prepared'; end if;
      if exists(select 1 from public.check_items where check_id=c.id and assessment_state='unreviewed') then raise exception 'Review every assessment line before quoting'; end if;
      if c.job_type='New Build' then raise exception 'New-build pricing is not yet configured in this pilot'; end if;
      -- Pilot uses an explicitly entered net assessment fee; no inferred tax treatment.
      subtotal := (payload->>'assessment_fee')::numeric;
      if subtotal is null or subtotal < 0 then raise exception 'Assessment fee must be zero or greater'; end if;
      update public.kit_checks set assessment_fee=subtotal where id=c.id;
      select coalesce(jsonb_agg(jsonb_build_object('description',ci.description,'quantity',l.needed,'unit_price',ci.unit_price) order by ci.source_code),'[]'::jsonb),
        coalesce(sum(l.needed*ci.unit_price),0) into lines,needed
      from public.check_items ci join public.line_quantities l on l.id=ci.id where ci.check_id=c.id and l.needed>0;
      lines := lines || jsonb_build_array(jsonb_build_object('description','Assessment fee (net, manually reviewed)','quantity',1,'unit_price',subtotal));
      insert into public.quotes(check_id,subtotal,lines) values(c.id,round(subtotal+needed,2),lines);
      update public.kit_checks set status='awaiting_approval' where id=c.id;
    elsif action='approve_quote' then
      if c.status <> 'awaiting_approval' then raise exception 'No quote awaiting approval'; end if;
      select * into strict q from public.quotes where check_id=c.id and status='draft' order by created_at desc limit 1;
      update public.quotes set status='approved',approved_at=now(),approved_by=auth.uid() where id=q.id;
      update public.kit_checks set status='packing' where id=c.id;
    elsif action='finish' then
      if c.status <> 'packing' then raise exception 'Check is not being packed'; end if;
      if exists(select 1 from public.line_quantities l where l.check_id=c.id and (l.assessment_state='unreviewed' or l.needed>l.supplied)) then raise exception 'Outstanding assessment or packing remains'; end if;
      update public.kit_checks set status='complete' where id=c.id;
    else raise exception 'Unsupported command'; end if;
  end if;
  insert into public.audit_events(actor,action,record_id) values(auth.uid(),action,result);
  return result;
end $$;
revoke all on function public.workspace_command(text,jsonb) from public,anon;
grant execute on function public.workspace_command(text,jsonb) to authenticated;
commit;
