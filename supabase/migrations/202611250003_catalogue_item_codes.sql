-- Requires the vendor catalogue attributes added by 202611200001_templates.sql.
begin;

alter table public.vendor_products add column catalogue_item_id text unique;
create sequence public.catalogue_item_number;
revoke all on sequence public.catalogue_item_number from public,anon,authenticated;

create function public.next_catalogue_item_id() returns text
language plpgsql security definer set search_path = '' as $$
declare
  number text;
  candidate text;
begin
  loop
    number := nextval('public.catalogue_item_number'::regclass)::text;
    candidate := 'MMA-' || lpad(number,greatest(6,length(number)),'0');
    exit when not exists (
      select 1 from public.vendor_products p where p.catalogue_item_id=candidate
        or upper(trim(p.attributes->>'mma_article_number'))=candidate
    );
  end loop;
  return candidate;
end;
$$;
revoke all on function public.next_catalogue_item_id() from public,anon,authenticated;

create function public.set_catalogue_item_id() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.catalogue_item_id is null and nullif(trim(new.attributes->>'mma_article_number'),'') is null then
    new.catalogue_item_id := public.next_catalogue_item_id();
  end if;
  return new;
end;
$$;
create trigger set_catalogue_item_id before insert on public.vendor_products
for each row execute function public.set_catalogue_item_id();

create table public.catalogue_product_codes (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.vendor_products(id) on delete cascade,
  framework text not null check (framework in ('MSN','Malta')),
  code text not null check (length(code) <= 250 and code ~ '[^[:space:]]'),
  code_key text generated always as (lower(trim(regexp_replace(code, '[[:space:]]+', ' ', 'g')))) stored,
  role text not null check (role in ('preferred','alternative')),
  unique (product_id,framework,code_key)
);
create unique index catalogue_preferred_product_per_code on public.catalogue_product_codes(framework,code_key)
where role='preferred';
alter table public.catalogue_product_codes enable row level security;
revoke all on public.catalogue_product_codes from public,anon,authenticated;
grant select on public.catalogue_product_codes to authenticated;
create policy catalogue_product_codes_staff on public.catalogue_product_codes
for select to authenticated using (public.is_staff());

create function public.workspace_catalogue_command(action text,payload jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  result uuid;
  product uuid := (payload->>'product_id')::uuid;
begin
  if not public.is_staff() then raise exception 'Staff access required' using errcode='42501'; end if;

  if action='assign_catalogue_item_id' then
    select id into result from public.vendor_products where id=product for update;
    if result is null then raise exception 'Product not found'; end if;
    update public.vendor_products set catalogue_item_id=public.next_catalogue_item_id()
    where id=product and catalogue_item_id is null and nullif(trim(attributes->>'mma_article_number'),'') is null;
  elsif action='save_catalogue_product_code' then
    insert into public.catalogue_product_codes(product_id,framework,code,role)
    values(product,payload->>'framework',trim(payload->>'code'),payload->>'role')
    on conflict(product_id,framework,code_key) do update set role=excluded.role
    returning id into result;
  elsif action='unlink_catalogue_product_code' then
    delete from public.catalogue_product_codes where id=(payload->>'link_id')::uuid returning id into result;
    if result is null then raise exception 'Catalogue link not found'; end if;
  else
    raise exception 'Unknown catalogue command';
  end if;

  insert into public.audit_events(actor,action,record_id) values(auth.uid(),action,result);
  return result;
exception when unique_violation then
  if action='save_catalogue_product_code' then
    raise exception 'This code already has a preferred product. Change that link to Alternative first';
  end if;
  raise;
end;
$$;
revoke all on function public.workspace_catalogue_command(text,jsonb) from public,anon;
grant execute on function public.workspace_catalogue_command(text,jsonb) to authenticated;

commit;
