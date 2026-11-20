-- Apply after 202611200001_templates.sql. Retains existing records and staff access.
begin;
alter table public.clients add column attributes jsonb not null default '{}';
alter table public.vessels add column attributes jsonb not null default '{}';
alter table public.kit_checks add column attributes jsonb not null default '{}';
create table public.import_sources (
 id uuid primary key,
 client_id uuid references public.clients(id),
 vessel_name text not null,
 source_path text not null,
 source_hash text not null,
 status text not null check(status in ('needs_review','supporting','superseded','imported')),
 attributes jsonb not null default '{}'
);
alter table public.import_sources enable row level security;
revoke all on public.import_sources from public,anon,authenticated;
grant select on public.import_sources to authenticated;
create policy staff_read on public.import_sources for select to authenticated using(public.is_staff());

alter function public.workspace_command(text,jsonb) rename to workspace_command_v2;
revoke all on function public.workspace_command_v2(text,jsonb) from public,anon,authenticated;

create function public.workspace_command(action text,payload jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare
 i public.check_items; c public.kit_checks; original_description text; check_id_value uuid;
 replacement text; reason text; required numeric; price numeric; result uuid;
begin
 if not public.is_staff() then raise exception 'Staff access required' using errcode='42501'; end if;
 if action in ('create_quote','finish') then
   select * into strict c from public.kit_checks where id=(payload->>'check_id')::uuid for update;
   if c.attributes->>'imported'='true' and c.attributes->>'review_required'='true' then raise exception 'Review the imported workbook issues and record the import review first'; end if;
   if exists(select 1 from public.check_items where check_id=c.id and attributes->>'requirement_unknown'='true') then raise exception 'Review unknown imported quantities before continuing'; end if;
 end if;
 if action='acknowledge_import_review' then
   select * into strict c from public.kit_checks where id=(payload->>'check_id')::uuid for update;
   if c.attributes->>'imported' is distinct from 'true' then raise exception 'This is not an imported check'; end if;
   reason:=trim(payload->>'reason');
   if coalesce(reason,'')='' or length(reason)>4000 then raise exception 'Record your review notes'; end if;
   update public.kit_checks set attributes=attributes || jsonb_build_object('review_required',false,'reviewed_by',auth.uid(),'reviewed_at',now(),'review_notes',reason) where id=c.id;
   insert into public.audit_events(actor,action,record_id,details) values(auth.uid(),action,c.id,jsonb_build_object('before',c.attributes,'reason',reason));
   return c.id;
 end if;
 if action <> 'edit_check_item' then
   result:=public.workspace_command_v2(action,payload);
   if action='finish' then update public.kit_checks set attributes=attributes || '{"forecast_eligible":true}'::jsonb where id=result; end if;
   return result;
 end if;
 if jsonb_typeof(payload) is distinct from 'object' then raise exception 'Command payload must be an object'; end if;
 select check_id into strict check_id_value from public.check_items where id=(payload->>'item_id')::uuid;
 select * into strict c from public.kit_checks where id=check_id_value for update;
 select * into strict i from public.check_items where id=(payload->>'item_id')::uuid for update;
 if c.status not in ('assessing','packing') then raise exception 'Line editing is locked while a quote awaits approval or after completion'; end if;
 reason:=trim(payload->>'reason');
 if coalesce(reason,'')='' or length(reason)>4000 then raise exception 'A reason is required (maximum 4000 characters)'; end if;
 replacement:=trim(coalesce(payload->>'substitute_description',''));
 if length(replacement)>500 then raise exception 'Substitute description is too long'; end if;
 required:=(payload->>'required_packs')::numeric;
 price:=(payload->>'unit_price')::numeric;
 if required is null or price is null or required<0 or price<0 or required>1000000 or price>1000000 then raise exception 'Valid non-negative quantity and price required'; end if;
 if c.status='packing' and (required<>i.required_packs or price<>i.unit_price or coalesce(payload->>'pack_description','')<>i.pack_description) then
   raise exception 'Quantity, pack size and price are locked after quote approval; review a revised quote before changing them';
 end if;
 original_description:=coalesce(i.attributes->>'original_description',i.description);
 update public.check_items set
   description=case when replacement='' then original_description else replacement end,
   pack_description=coalesce(payload->>'pack_description',''),
   required_packs=required,unit_price=price,
   attributes=i.attributes || jsonb_build_object(
     'original_description',original_description,
     'original_required_packs',coalesce(i.attributes->'original_required_packs',to_jsonb(i.required_packs)),
     'original_unit_price',coalesce(i.attributes->'original_unit_price',to_jsonb(i.unit_price)),
     'original_pack_description',coalesce(i.attributes->'original_pack_description',to_jsonb(i.pack_description)),
     'substitute_description',replacement,'override_reason',reason,
     'requirement_unknown',false,'price_missing',false,
     'edited_at',now(),'edited_by',auth.uid())
 where id=i.id;
 insert into public.audit_events(actor,action,record_id,details)
 values(auth.uid(),action,c.id,jsonb_build_object('before',to_jsonb(i),'changes',payload,'check_id',c.id));
 return c.id;
end $$;
revoke all on function public.workspace_command(text,jsonb) from public,anon;
grant execute on function public.workspace_command(text,jsonb) to authenticated;
commit;
