-- Apply after the workflow migration. Existing versions and check snapshots are retained.
begin;

alter function public.workspace_command(text,jsonb) rename to workspace_command_v4;
revoke all on function public.workspace_command_v4(text,jsonb) from public,anon,authenticated;

create function public.workspace_command(action text, payload jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  result uuid;
begin
  if not public.is_staff() then raise exception 'Staff access required' using errcode = '42501'; end if;

  if action = 'publish_template' then
    lock table public.kit_templates in share row exclusive mode;
    if exists (
      select 1 from public.template_items
      where template_id = (payload->>'template_id')::uuid
        and (attributes->'price_quantity_reviewed' is distinct from 'true'::jsonb
          or attributes->>'price_missing' = 'true'
          or attributes->>'requirement_unknown' = 'true'
          or (scaling = 'fixed' and baseline_packs <> trunc(baseline_packs)))
    ) then
      raise exception 'Review prices and quantities on every line before publishing';
    end if;
  end if;

  result := public.workspace_command_v4(action,payload);
  if action = 'create_template' and payload ? 'source_template_id' then
    update public.template_items set attributes = attributes - 'price_quantity_reviewed'
    where template_id = result;
  end if;
  return result;
end;
$$;

revoke all on function public.workspace_command(text,jsonb) from public,anon;
grant execute on function public.workspace_command(text,jsonb) to authenticated;
commit;
