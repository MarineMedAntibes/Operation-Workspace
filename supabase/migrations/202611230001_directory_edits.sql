-- Apply to the existing workspace as the database owner.
begin;

create or replace function public.workspace_directory_command(action text, payload jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  result uuid;
  record_id uuid := (payload->>'id')::uuid;
  linked_client uuid;
  season text := coalesce(payload->>'active_season', '');
begin
  if not public.is_staff() then raise exception 'Staff access required' using errcode = '42501'; end if;

  case action
    when 'update_client' then
      if season !~ '^(20[0-9]{2})?$' then raise exception 'Enter a valid active season'; end if;
      update public.clients set name = trim(payload->>'name'), email = nullif(payload->>'email',''),
        phone = nullif(payload->>'phone',''), notes = nullif(payload->>'notes',''),
        billing_address = nullif(payload->>'billing_address',''),
        attributes = case when season = '' then attributes - 'active_season'
          else attributes || jsonb_build_object('active_season', season) end
      where id = record_id returning id into result;
    when 'update_vendor' then
      update public.vendors set name = trim(payload->>'name'), email = nullif(payload->>'email',''),
        phone = nullif(payload->>'phone',''), notes = nullif(payload->>'notes','')
      where id = record_id returning id into result;
    when 'update_vendor_product' then
      if coalesce(trim(payload->>'description'),'') = '' then raise exception 'Description required'; end if;
      update public.vendor_products set vendor_id = nullif(payload->>'vendor_id','')::uuid,
        description = trim(payload->>'description'), sku = nullif(payload->>'sku',''),
        pack_description = nullif(payload->>'pack_description',''), price = (payload->>'price')::numeric,
        attributes = case when price is distinct from (payload->>'price')::numeric
          or nullif(pack_description,'') is distinct from nullif(payload->>'pack_description','')
          or vendor_id is distinct from nullif(payload->>'vendor_id','')::uuid
          then (attributes - 'unit_price') || jsonb_build_object('review_required', true) else attributes end
      where id = record_id returning id into result;
    when 'create_vessel', 'update_vessel' then
      if coalesce(payload->>'framework','') not in ('MSN','Malta','Other') then raise exception 'Choose a framework'; end if;
      linked_client := nullif(payload->>'client_id','')::uuid;
      if payload ? 'new_client' then
        if linked_client is not null then raise exception 'Choose an existing client or add a new one'; end if;
        linked_client := public.workspace_command('create_client', payload->'new_client');
      end if;
      if action = 'create_vessel' then
        insert into public.vessels(name,client_id,framework,flag_state,crew,loyalty)
        values(trim(payload->>'name'),linked_client,payload->>'framework',nullif(payload->>'flag_state',''),
          (payload->>'crew')::integer, coalesce((payload->>'loyalty')::boolean,false))
        returning id into result;
      else
        update public.vessels set name = trim(payload->>'name'), client_id = linked_client,
          framework = payload->>'framework', flag_state = nullif(payload->>'flag_state',''),
          crew = (payload->>'crew')::integer, loyalty = coalesce((payload->>'loyalty')::boolean,false)
        where id = record_id returning id into result;
      end if;
    else raise exception 'Unknown directory command';
  end case;

  if result is null then raise exception 'Record not found'; end if;
  insert into public.audit_events(actor,action,record_id) values(auth.uid(),action,result);
  return result;
end;
$$;

revoke all on function public.workspace_directory_command(text,jsonb) from public,anon;
grant execute on function public.workspace_directory_command(text,jsonb) to authenticated;
commit;
