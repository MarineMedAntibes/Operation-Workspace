-- Apply after 202611240001_template_review.sql.
begin;

create table public.template_sell_prices (
  item_key text not null,
  pack_key text not null,
  unit_price numeric(14,4) not null check (unit_price between 0 and 1000000),
  primary key (item_key, pack_key)
);
alter table public.template_sell_prices enable row level security;
revoke all on public.template_sell_prices from public, anon, authenticated;
grant select on public.template_sell_prices to authenticated;
create policy template_sell_prices_staff on public.template_sell_prices for select to authenticated using (public.is_staff());

create function public.template_price_key(value text) returns text
language sql immutable set search_path = '' as $$
  select lower(trim(regexp_replace(coalesce(value,''), '[[:space:]]+', ' ', 'g')))
$$;

alter function public.workspace_command(text,jsonb) rename to workspace_command_v5;
revoke all on function public.workspace_command_v5(text,jsonb) from public,anon,authenticated;

create function public.workspace_command(action text,payload jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  result uuid;
  target uuid;
  item_key_value text;
  pack_key_value text;
  supplied_price numeric(14,4);
  parent_price numeric(14,4);
  attrs jsonb;
  propagate boolean := false;
begin
  if not public.is_staff() then raise exception 'Staff access required' using errcode='42501'; end if;

  if action in ('delete_template', 'save_template_item', 'create_template') then
    lock table public.kit_templates in share row exclusive mode;
  end if;

  if action = 'delete_template' then
    target := (payload->>'template_id')::uuid;
    perform 1 from public.kit_templates t where t.id = target and not t.published and not t.ever_published
      and not exists(select 1 from public.kit_checks c where c.template_id = t.id);
    if not found then raise exception 'Only unused drafts can be deleted. Retire published versions.'; end if;
    delete from public.template_items where template_id = target;
    delete from public.kit_templates where id = target;
    insert into public.audit_events(actor,action,record_id) values(auth.uid(),action,target);
    return target;
  end if;

  if action = 'save_template_item' then
    attrs := coalesce(payload->'attributes','{}'::jsonb);
    item_key_value := public.template_price_key(attrs->>'item_id');
    pack_key_value := public.template_price_key(payload->>'pack_description');
    if payload->'share_price' = 'true'::jsonb then
      if item_key_value = '' or pack_key_value = '' or attrs->>'price_missing' = 'true' then
        raise exception 'Enter an Item ID, pack breakdown and sell price to share a price';
      end if;
      supplied_price := (payload->>'unit_price')::numeric(14,4);
      insert into public.template_sell_prices(item_key,pack_key,unit_price)
      values(item_key_value,pack_key_value,supplied_price)
      on conflict(item_key,pack_key) do update set unit_price = excluded.unit_price;
      propagate := true;
    else
      select p.unit_price into parent_price from public.template_sell_prices p
      where p.item_key = item_key_value and p.pack_key = pack_key_value;
      if found and ((payload->>'unit_price')::numeric(14,4) is distinct from parent_price or attrs->>'price_missing' = 'true') then
        raise exception 'This item uses a shared price. Enter the shared amount or select Update shared price.';
      end if;
    end if;
  end if;

  result := public.workspace_command_v5(action,payload);

  if propagate or (action = 'create_template' and nullif(payload->>'source_template_id','') is not null) then
    update public.template_items i
    set unit_price = p.unit_price,
      attributes = (i.attributes - 'price_quantity_reviewed') || jsonb_build_object('price_missing',false)
    from public.template_sell_prices p, public.kit_templates t
    where i.template_id = t.id and not t.published and not t.ever_published
      and not exists(select 1 from public.kit_checks c where c.template_id = t.id)
      and p.item_key = public.template_price_key(i.attributes->>'item_id')
      and p.pack_key = public.template_price_key(i.pack_description)
      and (i.unit_price is distinct from p.unit_price or i.attributes->>'price_missing' = 'true')
      and ((propagate and p.item_key = item_key_value and p.pack_key = pack_key_value)
        or (action = 'create_template' and t.id = result));

    if propagate then
      insert into public.audit_events(actor,action,record_id,details)
      values(auth.uid(),'update_template_shared_price',result,
        jsonb_build_object('item_key',item_key_value,'pack_key',pack_key_value,'unit_price',supplied_price));
    end if;
  end if;
  return result;
end;
$$;

revoke all on function public.workspace_command(text,jsonb) from public,anon;
grant execute on function public.workspace_command(text,jsonb) to authenticated;
commit;
