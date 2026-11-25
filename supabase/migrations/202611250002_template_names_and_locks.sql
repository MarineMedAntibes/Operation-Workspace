-- Apply after 202611250001_template_edit_revisions.sql.
begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
alter table public.kit_templates add column edit_locked boolean not null default false;

create table public.template_edit_locks (
  template_id uuid primary key references public.kit_templates(id) on delete cascade,
  password_hash text not null
);
alter table public.template_edit_locks enable row level security;
revoke all on public.template_edit_locks from public, anon, authenticated;

alter function public.workspace_command(text,jsonb) rename to workspace_command_v8;
revoke all on function public.workspace_command_v8(text,jsonb) from public,anon,authenticated;

create function public.workspace_command(action text,payload jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  target public.kit_templates;
  password text;
  password_hash text;
  crypto_schema text;
  password_matches boolean;
  new_name text;
begin
  if not public.is_staff() then raise exception 'Staff access required' using errcode='42501'; end if;

  if action in ('rename_template','lock_template','unlock_template','save_template_item',
                'delete_template_item','delete_template','publish_template','retire_template') then
    lock table public.kit_templates in share row exclusive mode;
    select * into target from public.kit_templates where id = (payload->>'template_id')::uuid;
    if target.edit_locked and action <> 'unlock_template' then
      raise exception 'Unlock this draft before making changes';
    end if;
  end if;

  if action in ('rename_template','lock_template','unlock_template') then
    if target.id is null then raise exception 'Template not found'; end if;
    if target.published or target.ever_published or exists(select 1 from public.kit_checks where template_id=target.id) then
      raise exception 'Only editable drafts can be renamed or password-locked';
    end if;

    if action = 'rename_template' then
      new_name := trim(payload->>'name');
      if coalesce(length(new_name),0) not between 1 and 500 then raise exception 'Enter a template name'; end if;
      update public.kit_templates set name=new_name where id=target.id;
    else
      password := payload->>'password';
      if coalesce(length(password),0) < 12 or octet_length(password) > 72 or trim(password) = '' then
        raise exception 'Use a passphrase of at least 12 characters and at most 72 bytes';
      end if;
      select n.nspname into strict crypto_schema from pg_catalog.pg_extension e
      join pg_catalog.pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto';
      if action = 'lock_template' then
        execute format('select %I.crypt($1,%I.gen_salt(''bf'',10))',crypto_schema,crypto_schema)
          into password_hash using password;
        insert into public.template_edit_locks(template_id,password_hash) values(target.id,password_hash);
        update public.kit_templates set edit_locked=true where id=target.id;
      else
        if not target.edit_locked then raise exception 'This draft is already unlocked'; end if;
        select l.password_hash into strict password_hash from public.template_edit_locks l where l.template_id=target.id;
        execute format('select %I.crypt($1,$2) = $2',crypto_schema) into password_matches using password,password_hash;
        if password_matches is distinct from true then raise exception 'Incorrect template passphrase'; end if;
        delete from public.template_edit_locks where template_id=target.id;
        update public.kit_templates set edit_locked=false where id=target.id;
      end if;
    end if;
    insert into public.audit_events(actor,action,record_id) values(auth.uid(),action,target.id);
    return target.id;
  end if;

  if action = 'save_template_item' and payload->'share_price' = 'true'::jsonb and exists (
    select 1 from public.template_items i join public.kit_templates t on t.id=i.template_id
    where t.edit_locked and public.template_price_key(i.attributes->>'item_id')=public.template_price_key(payload#>>'{attributes,item_id}')
      and public.template_price_key(i.pack_description)=public.template_price_key(payload->>'pack_description')
      and (i.unit_price is distinct from (payload->>'unit_price')::numeric(14,4) or i.attributes->>'price_missing'='true')
  ) then
    raise exception 'A matching draft is locked. Unlock it before updating the shared price';
  end if;

  return public.workspace_command_v8(action,payload);
end;
$$;
revoke all on function public.workspace_command(text,jsonb) from public,anon;
grant execute on function public.workspace_command(text,jsonb) to authenticated;
commit;
