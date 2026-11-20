-- Apply after 202610270001_workspace.sql. Existing checks and login accounts are retained.
begin;
alter table public.kit_templates add column ever_published boolean not null default false;
update public.kit_templates set ever_published = true where published or id in (select template_id from public.kit_checks);
-- Keep the most recently created legacy version active if a family has several.
with ranked as (select id, row_number() over(partition by framework,category order by version desc,id) as n from public.kit_templates where published)
update public.kit_templates set published=false where id in (select id from ranked where n>1);
create unique index one_published_template_per_family on public.kit_templates(framework,category) where published;
alter table public.vendor_products add column attributes jsonb not null default '{}';
alter table public.check_items add column attributes jsonb not null default '{}';
alter table public.check_items add column kill_line boolean not null default false;
alter table public.audit_events add column details jsonb not null default '{}';
update public.check_items c set attributes=t.attributes from public.template_items t where c.template_item_id=t.id;

create function public.snapshot_template_attributes() returns trigger language plpgsql set search_path='' as $$
begin
  select attributes into new.attributes from public.template_items where id=new.template_item_id;
  return new;
end $$;
revoke all on function public.snapshot_template_attributes() from public,anon,authenticated;
create trigger snapshot_template_attributes before insert on public.check_items for each row execute function public.snapshot_template_attributes();

create or replace view public.line_quantities with (security_invoker=true) as
select i.id,i.check_id,i.assessment_state,
 coalesce(sum(b.quantity) filter(where b.kind='kept'),0) as kept,
 coalesce(sum(b.quantity) filter(where b.kind='supplied'),0) as supplied,
 case when i.assessment_state='not_applicable' or i.kill_line then 0 else greatest(0,i.required_packs-coalesce(sum(b.quantity) filter(where b.kind='kept'),0)) end as needed
from public.check_items i left join public.batches b on b.check_item_id=i.id group by i.id;

alter function public.workspace_command(text,jsonb) rename to workspace_command_v1;
revoke all on function public.workspace_command_v1(text,jsonb) from public,anon,authenticated;

create function public.workspace_command(action text,payload jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare
 result uuid; t public.kit_templates; source public.kit_templates; check_id_value uuid;
begin
 if not public.is_staff() then raise exception 'Staff access required' using errcode='42501'; end if;
 if jsonb_typeof(payload) is distinct from 'object' then raise exception 'Command payload must be an object'; end if;
 if action in ('create_template','save_template_item','delete_template_item','publish_template','retire_template') then
   -- Serialize template writes, including family publication and check creation.
   lock table public.kit_templates in share row exclusive mode;
   if action='create_template' then
     if coalesce(trim(payload->>'name'),'')='' or coalesce(trim(payload->>'category'),'')='' or coalesce(trim(payload->>'version'),'')='' then raise exception 'Name, category and version required'; end if;
     if coalesce(payload->>'framework','') not in ('MSN','Malta','ALL') then raise exception 'Invalid framework'; end if;
     if nullif(payload->>'source_template_id','') is not null then
       select * into strict source from public.kit_templates where id=(payload->>'source_template_id')::uuid;
       if source.framework <> payload->>'framework' or source.category <> trim(payload->>'category') then raise exception 'A new version must keep its source framework and category'; end if;
     end if;
     insert into public.kit_templates(name,framework,category,version)
     values(trim(payload->>'name'),payload->>'framework',trim(payload->>'category'),trim(payload->>'version')) returning id into result;
     if source.id is not null then
       insert into public.template_items(template_id,source_code,description,location,pack_description,baseline_packs,scaling,unit_price,attributes)
       select result,source_code,description,location,pack_description,baseline_packs,scaling,unit_price,attributes from public.template_items where template_id=source.id;
     end if;
   else
     select * into strict t from public.kit_templates where id=(payload->>'template_id')::uuid for update;
     result:=t.id;
     if action='publish_template' then
       if not exists(select 1 from public.template_items where template_id=t.id) then raise exception 'Template has no items'; end if;
       if exists(select 1 from public.template_items where template_id=t.id and attributes->>'price_missing'='true') then raise exception 'Review missing sell prices before publishing'; end if;
       update public.kit_templates set published=false,ever_published=true where framework=t.framework and category=t.category and published;
       update public.kit_templates set published=true,ever_published=true where id=t.id;
     elsif action='retire_template' then
       update public.kit_templates set published=false,ever_published=ever_published or published where id=t.id;
     else
       if t.published or t.ever_published or exists(select 1 from public.kit_checks where template_id=t.id) then raise exception 'Published or used templates are immutable. Create a new version.'; end if;
       if action='delete_template_item' then
         delete from public.template_items where template_id=t.id and id=(payload->>'item_id')::uuid;
         if not found then raise exception 'Template item not found'; end if;
       else
         if coalesce(trim(payload->>'source_code'),'')='' or coalesce(trim(payload->>'description'),'')='' then raise exception 'Line key and description required'; end if;
         if coalesce(payload->>'scaling','') not in ('fixed','band') then raise exception 'Invalid scaling'; end if;
         if (payload->>'baseline_packs')::numeric is null or (payload->>'baseline_packs')::numeric<0 or (payload->>'baseline_packs')::numeric>1000000 then raise exception 'Invalid baseline quantity'; end if;
         if (payload->>'unit_price')::numeric is null or (payload->>'unit_price')::numeric<0 or (payload->>'unit_price')::numeric>1000000 then raise exception 'Invalid price'; end if;
         if payload ? 'attributes' and jsonb_typeof(payload->'attributes') is distinct from 'object' then raise exception 'Attributes must be an object'; end if;
         if nullif(payload->>'item_id','') is null then
           insert into public.template_items(template_id,source_code,description,location,pack_description,baseline_packs,scaling,unit_price,attributes)
           values(t.id,trim(payload->>'source_code'),trim(payload->>'description'),coalesce(payload->>'location',''),coalesce(payload->>'pack_description',''),(payload->>'baseline_packs')::numeric,payload->>'scaling',(payload->>'unit_price')::numeric,coalesce(payload->'attributes','{}'::jsonb));
         else
           update public.template_items set source_code=trim(payload->>'source_code'),description=trim(payload->>'description'),location=coalesce(payload->>'location',''),pack_description=coalesce(payload->>'pack_description',''),baseline_packs=(payload->>'baseline_packs')::numeric,scaling=payload->>'scaling',unit_price=(payload->>'unit_price')::numeric,attributes=coalesce(payload->'attributes','{}'::jsonb)
           where id=(payload->>'item_id')::uuid and template_id=t.id;
           if not found then raise exception 'Template item not found'; end if;
         end if;
       end if;
     end if;
   end if;
 elsif action='set_kill_line' then
   select check_id into strict check_id_value from public.check_items where id=(payload->>'item_id')::uuid;
   perform 1 from public.kit_checks where id=check_id_value and status='assessing' for update;
   if not found then raise exception 'Assessment is locked'; end if;
   if jsonb_typeof(payload->'kill_line') is distinct from 'boolean' then raise exception 'Kill line must be boolean'; end if;
   update public.check_items set kill_line=(payload->>'kill_line')::boolean where id=(payload->>'item_id')::uuid;
   result:=check_id_value;
 else
   if action='create_check' then lock table public.kit_templates in share row exclusive mode; end if;
   if action='create_quote' and exists(select 1 from public.check_items where check_id=(payload->>'check_id')::uuid and attributes->>'price_missing'='true') then raise exception 'Review missing sell prices before quoting'; end if;
   return public.workspace_command_v1(action,payload);
 end if;
 insert into public.audit_events(actor,action,record_id,details) values(auth.uid(),action,result,payload);
 return result;
end $$;
revoke all on function public.workspace_command(text,jsonb) from public,anon;
grant execute on function public.workspace_command(text,jsonb) to authenticated;
commit;
