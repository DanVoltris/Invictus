-- 0053 — The every-minute waiting-list sweep calls the website only when there is work to do.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run. Needs 0019 and 0022.
--
-- pg_cron runs the "waitlist-sweep" job every minute and it POSTs to /api/waitlist?action=sweep
-- (setup.sql §10). On almost every minute there is nothing to do, yet each POST starts a Vercel
-- function that makes four database round trips to find that out — about 1,440 function calls a
-- day, the biggest single use of the project's Vercel CPU.
--
-- waitlist_sweep_due() asks the same questions inside Postgres, where they cost nothing, and the job
-- now posts only when one of them is true. It is true exactly when the sweep would act:
--   (1) an offer's claim window has lapsed                         → expire it, offer the next person
--   (2) an offer nobody has been told about yet                    → announce it
--   (3) an entry whose time window has passed                      → close it
--   (4) a freed slot is queued and it is not quiet hours           → match it to someone waiting
--   (5) a queued message (text / email) is due to send             → deliver it
-- In quiet hours the sweep never touches the queue (waitlist_process returns before step 4), so
-- skipping the call then changes nothing either. When it is false the sweep would have done nothing.

create or replace function public.waitlist_sweep_due() returns boolean
language sql stable security definer set search_path = public, pg_temp as $fn$
  select
       exists (select 1 from public.waitlist_offers
                where status = 'offered' and (expires_at <= now() or notified_at is null))
    or exists (select 1 from public.waitlist_entries e
                where e.status in ('active', 'offered')
                  and (e.booking_date + make_interval(mins => e.window_end_min))
                      at time zone (public.waitlist_config()->>'timezone') < now())
    or (exists (select 1 from public.waitlist_wakeups where processed_at is null)
        and not public.waitlist_quiet_now())
    or exists (select 1 from public.notifications where status = 'queued' and send_after <= now());
$fn$;
revoke all on function public.waitlist_sweep_due() from public, anon, authenticated;

-- Scheduling from now on (setup.sql §10's helper, with the "only when due" condition added).
create or replace function public.waitlist_schedule_sweep(
  p_url text, p_secret text default null, p_schedule text default '* * * * *'
) returns text language plpgsql as $$
declare v_sql text; v_id bigint;
begin
  if to_regclass('cron.job') is null then
    return 'pg_cron is not installed — enable it in Supabase → Database → Extensions, then run this again.';
  end if;
  if to_regproc('net.http_post') is null then
    return 'pg_net is not installed — enable it in Supabase → Database → Extensions, then run this again.';
  end if;

  perform cron.unschedule(jobid) from cron.job where jobname = 'waitlist-sweep';

  v_sql := format(
    'select net.http_post(url := %L, headers := %L::jsonb, body := %L::jsonb, timeout_milliseconds := 8000) where public.waitlist_sweep_due()',
    p_url,
    jsonb_build_object('Content-Type', 'application/json',
                       'x-waitlist-secret', coalesce(p_secret, ''))::text,
    '{}');
  select cron.schedule('waitlist-sweep', p_schedule, v_sql) into v_id;
  return format('waitlist-sweep scheduled as job %s (%s) → %s, only when there is work', v_id, p_schedule, p_url);
end $$;

-- The job already running: add the condition to its command, keeping its URL and secret as they are.
do $$
declare j record; v_new text;
begin
  if to_regclass('cron.job') is null then
    raise notice '0053: pg_cron is not installed here, so there is no sweep job to change.';
    return;
  end if;
  for j in select jobid, command from cron.job where jobname = 'waitlist-sweep' loop
    if position('waitlist_sweep_due' in j.command) > 0 then
      raise notice '0053: the waitlist-sweep job already runs only when due.';
      continue;
    end if;
    v_new := regexp_replace(j.command, ';\s*$', '') || ' where public.waitlist_sweep_due()';
    begin
      perform cron.alter_job(j.jobid, command := v_new);
    exception when undefined_function then
      update cron.job set command = v_new where jobid = j.jobid;
    end;
    raise notice '0053: the waitlist-sweep job (%) now calls the website only when there is work.', j.jobid;
  end loop;
end $$;

do $$ begin
  raise notice '0053 applied: the waiting-list sweep runs only when there is something to do.';
end $$;
