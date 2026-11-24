-- Apply after 202611240002_template_shared_prices.sql.
begin;

alter function public.workspace_command(text,jsonb) rename to workspace_command_v6;
revoke all on function public.workspace_command_v6(text,jsonb) from public,anon,authenticated;

create function public.workspace_command(action text,payload jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  result uuid;
  previous_crew integer;
  maximum numeric;
begin
  if not public.is_staff() then raise exception 'Staff access required' using errcode='42501'; end if;

  if action = 'save_template_item' and (payload->'attributes') ? 'maximum_packs' then
    if jsonb_typeof(payload#>'{attributes,maximum_packs}') is distinct from 'number' then
      raise exception 'Enter a whole-pack maximum';
    end if;
    maximum := (payload#>>'{attributes,maximum_packs}')::numeric;
    if (payload->>'scaling') is distinct from 'band' or maximum <> trunc(maximum)
      or maximum not between 0 and 1000000 or maximum < round((payload->>'baseline_packs')::numeric)
      or (payload#>>'{attributes,requirement_unknown}') = 'true' then
      raise exception 'Enter a whole-pack maximum at least as large as the 10-crew quantity on a scaled line';
    end if;
  elsif action = 'save_check_header' then
    select crew into previous_crew from public.kit_checks where id = (payload->>'check_id')::uuid for update;
  end if;

  result := public.workspace_command_v6(action,payload);

  if action = 'create_check' or (action = 'save_check_header' and previous_crew <> (payload->>'crew')::integer) then
    update public.check_items i
    set required_packs = least(i.required_packs, (t.attributes->>'maximum_packs')::numeric)
    from public.template_items t
    where i.check_id = result and i.template_item_id = t.id and t.scaling = 'band'
      and jsonb_typeof(t.attributes->'maximum_packs') = 'number'
      and not (i.attributes ? 'edited_at') and not (i.attributes ? 'source_override_add_packs')
      and i.required_packs > (t.attributes->>'maximum_packs')::numeric;
  end if;
  return result;
end;
$$;

revoke all on function public.workspace_command(text,jsonb) from public,anon;
grant execute on function public.workspace_command(text,jsonb) to authenticated;

-- A cap submitted through the app must reach a database that supports caps.
create function public.save_capped_template_item(payload jsonb) returns uuid
language sql security invoker set search_path = '' as $$
  select public.workspace_command('save_template_item',payload)
$$;
revoke all on function public.save_capped_template_item(jsonb) from public,anon;
grant execute on function public.save_capped_template_item(jsonb) to authenticated;

commit;
