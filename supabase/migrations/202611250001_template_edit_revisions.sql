-- Apply after 202611240003_template_quantity_caps.sql.
begin;
alter table public.template_items add column edit_revision uuid not null default gen_random_uuid();

create function public.bump_template_edit_revision() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.edit_revision := gen_random_uuid();
  return new;
end;
$$;

create trigger bump_template_edit_revision before update on public.template_items
for each row execute function public.bump_template_edit_revision();

alter function public.workspace_command(text,jsonb) rename to workspace_command_v7;
revoke all on function public.workspace_command_v7(text,jsonb) from public,anon,authenticated;

create function public.workspace_command(action text,payload jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_staff() then raise exception 'Staff access required' using errcode='42501'; end if;

  if action in ('save_template_item','delete_template_item') and payload ? 'expected_revision' then
    lock table public.kit_templates in share row exclusive mode;
    if not exists (
      select 1 from public.template_items
      where id = (payload->>'item_id')::uuid
        and template_id = (payload->>'template_id')::uuid
        and edit_revision = (payload->>'expected_revision')::uuid
    ) then
      raise exception 'This line changed after you opened it. Refresh Templates and review the latest version before saving.';
    end if;
  end if;

  return public.workspace_command_v7(action,payload);
end;
$$;
revoke all on function public.workspace_command(text,jsonb) from public,anon;
grant execute on function public.workspace_command(text,jsonb) to authenticated;
commit;
