-- Fast two-expiry entry, configuration, finance snapshots and legacy stock.
begin;
alter table public.batches add column voided_at timestamptz;
alter table public.quotes add column superseded_at timestamptz;
alter table public.quotes add column financials jsonb not null default '{}';
drop index public.one_approved_quote;
create unique index one_approved_quote on public.quotes(check_id) where status='approved' and superseded_at is null;
create table public.pricing_rules (
 id uuid primary key default gen_random_uuid(), framework text not null, category text not null,
 crew_band integer not null check(crew_band in (10,20,30,40,60)), job_type text not null,
 standard_fee numeric not null check(standard_fee>=0), member_discount_percent numeric not null check(member_discount_percent between 0 and 100),
 proceeds_credit_percent numeric not null check(proceeds_credit_percent between 0 and 100),
 new_build_kit_price numeric check(new_build_kit_price>=0), review_required boolean not null default true,
 unique(framework,category,crew_band,job_type)
);
create table public.legacy_items (
 id uuid primary key default gen_random_uuid(), check_id uuid not null references public.kit_checks(id),
 description text not null check(length(trim(description))>0), quantity numeric not null check(quantity>=0),
 expiry date, no_expiry boolean not null default false, location text not null default '', notes text not null default '',
 check((no_expiry and expiry is null) or (not no_expiry and expiry is not null and extract(day from expiry)=1))
);
create table public.invoices (
 id uuid primary key default gen_random_uuid(), check_id uuid not null unique references public.kit_checks(id),
 quote_id uuid not null references public.quotes(id), invoice_number text not null unique,
 status text not null default 'draft' check(status in ('draft','issued','paid')),
 financials jsonb not null, created_at timestamptz not null default now()
);
do $$ declare t text; begin
 foreach t in array array['pricing_rules','legacy_items','invoices'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('create policy staff_read on public.%I for select to authenticated using(public.is_staff())',t);
 end loop;
end $$;
create index on public.legacy_items(check_id);
create index on public.invoices(check_id);
create or replace view public.line_quantities with (security_invoker=true) as
select i.id,i.check_id,i.assessment_state,
 coalesce(sum(b.quantity) filter(where b.kind='kept'),0) as kept,
 coalesce(sum(b.quantity) filter(where b.kind='supplied'),0) as supplied,
 case when i.assessment_state='not_applicable' or i.kill_line then 0 else greatest(0,i.required_packs-coalesce(sum(b.quantity) filter(where b.kind='kept'),0)) end as needed
from public.check_items i left join public.batches b on b.check_item_id=i.id and b.voided_at is null group by i.id;

create function public.finance_snapshot(check_value uuid,invoice_mode boolean default false) returns jsonb
language plpgsql set search_path='' as $$
declare
 c public.kit_checks; t public.kit_templates; r public.pricing_rules;
 f jsonb; x jsonb; line jsonb; result_lines jsonb:='[]';
 base numeric; fee numeric; member numeric; credit numeric; items numeric; kit numeric;
 goods numeric; service numeric; goods_rate numeric; service_rate numeric; ship_rate numeric;
 extras numeric:=0; coolbox numeric; shipping numeric; handling numeric; subtotal numeric:=0; tax numeric:=0;
 net numeric; rate numeric; line_tax numeric; band integer; missing boolean; proceeded boolean;
begin
 select * into strict c from public.kit_checks where id=check_value;
 select * into strict t from public.kit_templates where id=c.template_id;
 f:=coalesce(c.attributes#>'{workflow,finance}','{}');
 select min(v) into band from unnest(array[10,20,30,40,60]) v where v>=c.crew;
 select * into r from public.pricing_rules where framework=t.framework and category=t.category and crew_band=band and job_type=c.job_type;
 base:=coalesce((f->>'standard_fee')::numeric,r.standard_fee,0);
 member:=coalesce((f->>'loyalty_discount_percent')::numeric,r.member_discount_percent,0);
 credit:=coalesce((f->>'proceeds_credit_percent')::numeric,r.proceeds_credit_percent,0);
 proceeded:=coalesce((f->>'job_proceeded')::boolean,false);
 missing:=jsonb_typeof(f->'job_proceeded') is distinct from 'boolean';
 if c.job_type<>'New Build' and f->>'assessment_fee_override' is null then
  if coalesce((f->>'standard_fee')::numeric,r.standard_fee) is null then missing:=true; end if;
  if c.loyalty and coalesce((f->>'loyalty_discount_percent')::numeric,r.member_discount_percent) is null then missing:=true; end if;
  if proceeded and coalesce((f->>'proceeds_credit_percent')::numeric,r.proceeds_credit_percent) is null then missing:=true; end if;
  if coalesce(r.review_required,false) and not coalesce((f->>'pricing_reviewed')::boolean,false) and f->>'standard_fee' is null then missing:=true; end if;
 end if;
 if c.job_type='New Build' then fee:=0;
 else fee:=round(base*(1-case when c.loyalty then member/100 else 0 end)*(1-case when proceeded then credit/100 else 0 end),2); end if;
 fee:=coalesce((f->>'assessment_fee_override')::numeric,fee);
 select coalesce(round(sum(q.needed*i.unit_price),2),0) into items from public.check_items i join public.line_quantities q on q.id=i.id
 where i.check_id=c.id and (not invoice_mode or (q.needed<=q.supplied and i.assessment_state<>'unreviewed'));
 kit:=case when c.job_type='New Build' then coalesce((f->>'new_build_kit_price')::numeric,r.new_build_kit_price,0) else items end;
 if c.job_type='New Build' and coalesce((f->>'new_build_kit_price')::numeric,r.new_build_kit_price) is null then missing:=true; end if;
 if c.job_type='New Build' and coalesce(r.review_required,false) and not coalesce((f->>'pricing_reviewed')::boolean,false) and f->>'new_build_kit_price' is null then missing:=true; end if;
 kit:=round(kit,2); items:=kit;
 goods:=case when proceeded then round(kit*coalesce((f->>'goods_share_percent')::numeric,40)/100,2) else 0 end;
 service:=case when proceeded then kit-goods else 0 end;
 goods_rate:=coalesce((f->>'goods_vat_percent')::numeric,20); service_rate:=coalesce((f->>'service_vat_percent')::numeric,20); ship_rate:=coalesce((f->>'shipping_vat_percent')::numeric,20);
 coolbox:=case when proceeded then coalesce((f->>'coolbox')::numeric,0) else 0 end;
 shipping:=case when proceeded then coalesce((f->>'shipping')::numeric,0) else 0 end;
 handling:=case when proceeded then coalesce((f->>'handling')::numeric,0) else 0 end;
 for line in select value from jsonb_array_elements(jsonb_build_array(
  jsonb_build_object('key','assessment','description','1. Medical Stores Compliance Assessment','kind','service','quantity',1,'unit_price',fee),
  jsonb_build_object('key','kit_goods','description','Kit fulfilment — goods','kind','goods','quantity',1,'unit_price',goods),
  jsonb_build_object('key','kit_service','description','Kit fulfilment — service','kind','service','quantity',1,'unit_price',service),
  jsonb_build_object('key','coolbox','description','4. Coolbox / Packaging','kind','shipping','quantity',1,'unit_price',coolbox),
  jsonb_build_object('key','shipping','description','4. Freight / Shipping','kind','shipping','quantity',1,'unit_price',shipping),
  jsonb_build_object('key','handling','description','4. Additional Handling','kind','shipping','quantity',1,'unit_price',handling)
 ) || case when proceeded then coalesce(f->'extras','[]') else '[]'::jsonb end) loop
  net:=round((line->>'quantity')::numeric*(line->>'unit_price')::numeric,2);
  rate:=case line->>'kind' when 'goods' then goods_rate when 'shipping' then ship_rate else service_rate end;
  line_tax:=round(net*rate/100,2); subtotal:=subtotal+net; tax:=tax+line_tax;
  if line ? 'id' then extras:=extras+net; line:=line || jsonb_build_object('key','extra-' || (line->>'id'),'description','3. ' || (line->>'description')); end if;
  if net=0 and line->>'key' in ('coolbox','shipping','handling') then continue; end if;
  result_lines:=result_lines || jsonb_build_array(line || jsonb_build_object('net',net,'vat_percent',rate,'vat',line_tax,'total',net+line_tax));
 end loop;
 return jsonb_build_object('assessment_fee',fee,'items_subtotal',items,'goods_net',goods,'service_net',service,'extras_net',extras,'coolbox_net',coolbox,'shipping_net',shipping,'handling_net',handling,'subtotal',subtotal,'vat',tax,'total',subtotal+tax,'lines',result_lines,'tax_reviewed',coalesce((f->>'tax_reviewed')::boolean,false),'pricing_missing',missing,'inputs',f,'billing',jsonb_build_object('name',coalesce(nullif(c.attributes#>>'{workflow,billing_name}',''),(select name from public.clients where id=c.client_id)),'address',coalesce(nullif(c.attributes#>>'{workflow,billing_address}',''),(select billing_address from public.clients where id=c.client_id)),'vat_number',c.attributes#>>'{workflow,vat_number}','client_type',c.attributes#>>'{workflow,client_type}','tva_status',c.attributes#>>'{workflow,tva_status}','delivery_location',c.attributes#>>'{workflow,delivery_location}','vessel_name',(select name from public.vessels where id=c.vessel_id),'check_date',c.check_date,'valid_until',c.valid_until),'basis',case when invoice_mode then 'Completed replacement lines only' else 'Planned replacement lines' end);
end $$;
revoke all on function public.finance_snapshot(uuid,boolean) from public,anon,authenticated;

alter function public.workspace_command(text,jsonb) rename to workspace_command_v3;
revoke all on function public.workspace_command_v3(text,jsonb) from public,anon,authenticated;
create function public.workspace_command(action text,payload jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare
 c public.kit_checks; i public.check_items; q public.quotes; b public.batches;
 check_value uuid; result uuid; phase text; s jsonb; g jsonb; f jsonb; snapshot jsonb;
 total numeric:=0; qty integer; expiry_value date; noexp boolean; ids jsonb; actual_ids jsonb;
 previous jsonb; batch_kind text; reason text;
begin
 if not public.is_staff() then raise exception 'Staff access required' using errcode='42501'; end if;
 if jsonb_typeof(payload) is distinct from 'object' then raise exception 'Command payload must be an object'; end if;
 if action='save_line_slots' then
  select check_id into strict check_value from public.check_items where id=(payload->>'item_id')::uuid;
 else check_value:=nullif(payload->>'check_id','')::uuid; end if;
 if action in ('save_check_header','save_check_setup','save_line_slots','reconcile_stock','revise_quote','prepare_quote','create_invoice','save_finance_tracker','save_legacy_item','delete_legacy_item') then
  select * into strict c from public.kit_checks where id=check_value for update;
  result:=c.id;
  if action='save_check_header' then
   if c.status<>'assessing' or exists(select 1 from public.invoices where check_id=c.id) then raise exception 'Reopen assessment before changing check settings'; end if;
   if coalesce(trim(payload->>'reason'),'')='' or (payload->>'crew')::integer not between 1 and 60 or (payload->>'valid_until')::date<=(payload->>'check_date')::date or payload->>'job_type' not in ('Routine Refill','Category Swap','Restructure','New Build') then raise exception 'Check dates, crew, job type and correction reason'; end if;
   previous:=to_jsonb(c);
   update public.kit_checks set check_date=(payload->>'check_date')::date,valid_until=(payload->>'valid_until')::date,crew=(payload->>'crew')::integer,job_type=payload->>'job_type',loyalty=(payload->>'loyalty')::boolean,attributes=attributes || jsonb_build_object('header_correction_reason',payload->>'reason') where id=c.id;
   if c.attributes#>'{workflow,finance}' is not null then
    update public.kit_checks set attributes=jsonb_set(attributes,'{workflow,finance}',(attributes#>'{workflow,finance}')-array['standard_fee','assessment_fee_override','loyalty_discount_percent','proceeds_credit_percent','new_build_kit_price'] || '{"pricing_reviewed":false,"tax_reviewed":false}'::jsonb) where id=c.id;
   end if;
   if c.crew<>(payload->>'crew')::integer then
    update public.check_items ci set required_packs=case when t.scaling='fixed' then t.baseline_packs else round(t.baseline_packs*(select min(n) from unnest(array[10,20,30,40,60]) n where n>=(payload->>'crew')::integer)/10) end from public.template_items t where ci.check_id=c.id and t.id=ci.template_item_id and not(ci.attributes ? 'edited_at') and not(ci.attributes ? 'source_override_add_packs');
   end if;
   for b in select * from public.batches where check_item_id in(select id from public.check_items where check_id=c.id) and kind<>'supplied' and voided_at is null loop
    update public.batches set voided_at=now() where id=b.id;
    insert into public.batches(check_item_id,kind,quantity,expiry,no_expiry,notes,created_by) values(b.check_item_id,case when b.no_expiry or b.expiry+interval '1 month'>(payload->>'valid_until')::date then 'kept' else 'removed' end,b.quantity,b.expiry,b.no_expiry,'Reassessed after check header correction: ' || (payload->>'reason'),auth.uid());
   end loop;
   update public.check_items set assessment_state='unreviewed' where check_id=c.id;
  elsif action='save_check_setup' then
   if jsonb_typeof(payload->'workflow') is distinct from 'object' then raise exception 'Invalid setup'; end if;
   f:=payload#>'{workflow,finance}';
   if c.status<>'assessing' and coalesce(c.attributes#>'{workflow,finance}','{}') is distinct from f then raise exception 'Revise the quote before changing approved pricing'; end if;
   if jsonb_typeof(f) is distinct from 'object' or jsonb_typeof(f->'extras') is distinct from 'array' then raise exception 'Invalid finance settings'; end if;
   if coalesce((f->>'tax_reviewed')::boolean,false) and ((f->>'goods_vat_percent')::numeric=0 or (f->>'service_vat_percent')::numeric=0 or (f->>'shipping_vat_percent')::numeric=0) and coalesce(trim(f->>'tax_notes'),'')='' then raise exception 'Record the reason for zero VAT rates'; end if;
   for s in select value from jsonb_array_elements(f->'extras') loop
    if (s->>'quantity') is null or (s->>'unit_price') is null or (s->>'quantity')::numeric<0 or (s->>'unit_price')::numeric<0 or (s->>'quantity')::numeric>10000000 or (s->>'unit_price')::numeric>10000000 or coalesce(s->>'kind','') not in ('goods','service','shipping') then raise exception 'Invalid extra'; end if;
   end loop;
   for phase in select unnest(array['standard_fee','assessment_fee_override','new_build_kit_price','coolbox','shipping','handling','loyalty_discount_percent','proceeds_credit_percent','goods_share_percent','goods_vat_percent','service_vat_percent','shipping_vat_percent']) loop
    if (f->>phase)::numeric<0 or (f->>phase)::numeric>10000000 then raise exception 'Invalid finance amount'; end if;
    if phase like '%percent' and (f->>phase)::numeric>100 then raise exception 'Percent must be between zero and 100'; end if;
   end loop;
   update public.kit_checks set attributes=attributes || jsonb_build_object('workflow',payload->'workflow') where id=c.id;
  elsif action='save_line_slots' then
   phase:=payload->>'phase';
   if (phase='arrival' and c.status<>'assessing') or (phase='supply' and c.status<>'packing') or phase not in ('arrival','supply') then raise exception 'This stage is locked'; end if;
   select * into strict i from public.check_items where id=(payload->>'item_id')::uuid;
   if (payload->>'expected_valid_until' is not null and (payload->>'expected_valid_until')::date<>c.valid_until) or (payload->>'expected_required_packs' is not null and (payload->>'expected_required_packs')::numeric<>i.required_packs) then raise exception 'Check settings changed. Refresh before saving again'; end if;
   select coalesce(jsonb_agg(id::text order by id::text),'[]') into actual_ids from public.batches where check_item_id=i.id and voided_at is null and ((phase='arrival' and kind<>'supplied') or (phase='supply' and kind='supplied'));
   select coalesce(jsonb_agg(value order by value),'[]') into ids from jsonb_array_elements_text(payload->'expected_batch_ids');
   if actual_ids is distinct from ids then raise exception 'This line changed. Refresh before saving again'; end if;
   if jsonb_typeof(payload->'slots') is distinct from 'array' or jsonb_array_length(payload->'slots')>2 then raise exception 'Use no more than two expiry slots'; end if;
   ids:='[]';
   for s in select value from jsonb_array_elements(payload->'slots') loop
    qty:=(s->>'quantity')::integer;
    if qty is null or qty<0 or qty>100000 or (s->>'quantity')::numeric<>qty then raise exception 'Enter whole pack quantities'; end if;
    if qty=0 then continue; end if;
    noexp:=coalesce((s->>'no_expiry')::boolean,false); expiry_value:=nullif(s->>'expiry','')::date;
    if (noexp and expiry_value is not null) or (not noexp and (expiry_value is null or extract(day from expiry_value)<>1)) then raise exception 'Enter an expiry month or NED'; end if;
    phase:=payload->>'phase';
    batch_kind:=case when noexp then 'NED' else expiry_value::text end;
    if ids ? batch_kind then raise exception 'Combine quantities for the same expiry'; end if;
    ids:=ids || to_jsonb(batch_kind); total:=total+qty;
    if phase='supply' and not noexp and expiry_value+interval '1 month'<=c.valid_until-interval '1 month' then raise exception 'A supplied expiry does not cover the required window'; end if;
   end loop;
   if phase='supply' then
    if i.assessment_state<>'reviewed' then raise exception 'Review this item before packing'; end if;
    if total>(select needed from public.line_quantities where id=i.id) then raise exception 'Supply exceeds required packs'; end if;
   end if;
   select coalesce(jsonb_agg(to_jsonb(x)),'[]') into previous from public.batches x where check_item_id=i.id and voided_at is null and ((phase='arrival' and kind<>'supplied') or (phase='supply' and kind='supplied'));
   update public.batches set voided_at=now() where check_item_id=i.id and voided_at is null and ((phase='arrival' and kind<>'supplied') or (phase='supply' and kind='supplied'));
   for s in select value from jsonb_array_elements(payload->'slots') loop
    qty:=(s->>'quantity')::integer; if qty=0 then continue; end if;
    noexp:=coalesce((s->>'no_expiry')::boolean,false); expiry_value:=nullif(s->>'expiry','')::date;
    batch_kind:=case when phase='supply' then 'supplied' when noexp or expiry_value+interval '1 month'>c.valid_until then 'kept' else 'removed' end;
    insert into public.batches(check_item_id,kind,quantity,expiry,no_expiry,notes,created_by) values(i.id,batch_kind,qty,expiry_value,noexp,coalesce(payload->>'notes',''),auth.uid());
   end loop;
   if phase='arrival' then update public.check_items set assessment_state=case when coalesce((payload->>'reviewed')::boolean,true) then 'reviewed' else 'unreviewed' end where id=i.id; end if;
  elsif action='reconcile_stock' then
   if c.status<>'assessing' then raise exception 'Reconciliation is locked'; end if;
   if jsonb_typeof(payload->'groups') is distinct from 'array' or jsonb_array_length(payload->'groups')>500 then raise exception 'Invalid reconciliation groups'; end if;
   for g in select value from jsonb_array_elements(payload->'groups') loop
    if not exists(select 1 from public.check_items where id=(g->>'item_id')::uuid and check_id=c.id) then raise exception 'Match must belong to this check'; end if;
    perform public.workspace_command('save_line_slots',g || jsonb_build_object('phase','arrival','reviewed',false,'notes','Reconciled from ' || (payload->>'source_name')));
   end loop;
   update public.kit_checks set attributes=attributes || jsonb_build_object('reconciliation',jsonb_build_object('source',payload->>'source_name','groups',payload->'groups','confirmed_by',auth.uid(),'confirmed_at',now())) where id=c.id;
  elsif action='revise_quote' then
   if c.status='complete' or exists(select 1 from public.invoices where check_id=c.id) then raise exception 'Completed or invoiced checks require a separate correction'; end if;
   reason:=trim(payload->>'reason'); if coalesce(reason,'')='' then raise exception 'Record a revision reason'; end if;
   update public.quotes set superseded_at=now() where check_id=c.id and superseded_at is null;
   update public.kit_checks set status='assessing',attributes=attributes || jsonb_build_object('last_revision_reason',reason) where id=c.id;
  elsif action='prepare_quote' then
   if c.status<>'assessing' then raise exception 'Assessment must be open'; end if;
   if c.attributes->>'review_required'='true' then raise exception 'Record the import review first'; end if;
   if exists(select 1 from public.check_items where check_id=c.id and (assessment_state='unreviewed' or attributes->>'requirement_unknown'='true' or attributes->>'price_missing'='true')) then raise exception 'Review all quantities, prices and assessment lines'; end if;
   snapshot:=public.finance_snapshot(c.id,false);
   if c.attributes#>>'{workflow,finance,pricing_reviewed}' is distinct from 'true' then raise exception 'Review tax treatment and assessment pricing in Setup'; end if;
   if snapshot->>'tax_reviewed'<>'true' or snapshot->>'pricing_missing'='true' then raise exception 'Review tax treatment and assessment pricing in Setup'; end if;
   insert into public.quotes(check_id,subtotal,lines,financials) values(c.id,(snapshot->>'subtotal')::numeric,snapshot->'lines',snapshot);
   update public.kit_checks set status='awaiting_approval',assessment_fee=(snapshot->>'assessment_fee')::numeric where id=c.id;
  elsif action='create_invoice' then
   if c.status<>'complete' then raise exception 'Finish packing before preparing the invoice'; end if;
   select * into strict q from public.quotes where check_id=c.id and status='approved' and superseded_at is null;
   if coalesce(trim(payload->>'invoice_number'),'')='' then raise exception 'Invoice number required'; end if;
   snapshot:=public.finance_snapshot(c.id,true);
   if snapshot->>'tax_reviewed'<>'true' or snapshot->>'pricing_missing'='true' then raise exception 'Review invoice tax and pricing'; end if;
   insert into public.invoices(check_id,quote_id,invoice_number,financials) values(c.id,q.id,trim(payload->>'invoice_number'),snapshot);
  elsif action='save_finance_tracker' then
   if jsonb_typeof(payload->'tracker') is distinct from 'object' then raise exception 'Invalid tracker'; end if;
   if nullif(payload#>>'{tracker,invoice_paid_at}','') is not null and nullif(payload#>>'{tracker,invoice_sent_at}','') is null then raise exception 'Record the invoice sent date before marking it paid'; end if;
   if (nullif(payload#>>'{tracker,invoice_sent_at}','') is not null or nullif(payload#>>'{tracker,invoice_paid_at}','') is not null) and not exists(select 1 from public.invoices where check_id=c.id) then raise exception 'Prepare an invoice snapshot before recording invoice dates'; end if;
   update public.kit_checks set attributes=attributes || jsonb_build_object('finance_tracker',payload->'tracker') where id=c.id;
   update public.invoices set status=case when nullif(payload#>>'{tracker,invoice_paid_at}','') is not null then 'paid' when nullif(payload#>>'{tracker,invoice_sent_at}','') is not null then 'issued' else 'draft' end where check_id=c.id;
  elsif action='save_legacy_item' then
   if c.status='complete' then raise exception 'Completed checks are locked'; end if;
   if coalesce(trim(payload->>'description'),'')='' or (payload->>'quantity')::numeric<0 then raise exception 'Description and non-negative quantity required'; end if;
   if nullif(payload->>'item_id','') is null then
    insert into public.legacy_items(check_id,description,quantity,expiry,no_expiry,location,notes) values(c.id,trim(payload->>'description'),(payload->>'quantity')::numeric,nullif(payload->>'expiry','')::date,(payload->>'no_expiry')::boolean,coalesce(payload->>'location',''),coalesce(payload->>'notes',''));
   else
    update public.legacy_items set description=trim(payload->>'description'),quantity=(payload->>'quantity')::numeric,expiry=nullif(payload->>'expiry','')::date,no_expiry=(payload->>'no_expiry')::boolean,location=coalesce(payload->>'location',''),notes=coalesce(payload->>'notes','') where id=(payload->>'item_id')::uuid and check_id=c.id;
    if not found then raise exception 'Legacy item not found'; end if;
   end if;
  elsif action='delete_legacy_item' then
   if c.status='complete' then raise exception 'Completed checks are locked'; end if;
   delete from public.legacy_items where id=(payload->>'item_id')::uuid and check_id=c.id;
   if not found then raise exception 'Legacy item not found'; end if;
  end if;
  insert into public.audit_events(actor,action,record_id,details) values(auth.uid(),action,c.id,jsonb_build_object('changes',payload,'previous_batches',previous));
  return c.id;
 end if;
 if action='approve_quote' then
  select * into strict c from public.kit_checks where id=(payload->>'check_id')::uuid for update;
  if c.status<>'awaiting_approval' then raise exception 'No quote awaiting approval'; end if;
  select * into strict q from public.quotes where check_id=c.id and status='draft' and superseded_at is null order by created_at desc limit 1;
  update public.quotes set status='approved',approved_at=now(),approved_by=auth.uid() where id=q.id;
  update public.kit_checks set status='packing' where id=c.id;
  insert into public.audit_events(actor,action,record_id) values(auth.uid(),action,c.id);
  return c.id;
 end if;
 if action='add_batch' then
  select * into strict i from public.check_items where id=(payload->>'item_id')::uuid;
  select * into strict c from public.kit_checks where id=i.check_id for update;
  select count(distinct coalesce(expiry::text,'NED')) into qty from public.batches where check_item_id=i.id and voided_at is null and ((c.status='assessing' and kind<>'supplied') or (c.status='packing' and kind='supplied'));
  if qty>=2 and not exists(select 1 from public.batches where check_item_id=i.id and voided_at is null and ((c.status='assessing' and kind<>'supplied') or (c.status='packing' and kind='supplied')) and coalesce(expiry::text,'NED')=coalesce(nullif(payload->>'expiry',''),'NED')) then raise exception 'Use only two expiry dates per stage'; end if;
 end if;
 if action='edit_check_item' then
  result:=public.workspace_command_v3(action,payload);
  for phase in select unnest(array['dose_route','uses','side_effects']) loop
   if payload ? phase then
    if jsonb_typeof(payload->phase) is distinct from 'string' or length(payload->>phase)>4000 then raise exception 'Clinical directory fields must be reviewed text'; end if;
    update public.check_items set attributes=attributes || jsonb_build_object('original_' || phase,coalesce(attributes->('original_' || phase),attributes->phase,'""'::jsonb),phase,payload->phase) where id=(payload->>'item_id')::uuid;
   end if;
  end loop;
  return result;
 end if;
 return public.workspace_command_v3(action,payload);
end $$;
revoke all on function public.workspace_command(text,jsonb) from public,anon;
grant execute on function public.workspace_command(text,jsonb) to authenticated;
commit;
