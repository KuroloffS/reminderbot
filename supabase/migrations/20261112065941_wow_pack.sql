-- "Wow pack": data for the picture cards (activity per day), badges, mastered topics.
-- Everything here is additive: the previous version of the Edge Function keeps working with it.

alter table public.users
  add column achievements text[] not null default '{}',   -- badge codes already celebrated (lib/badges.ts)
  add column menu_version int not null default 0;         -- which command menu this chat was given

-- ---------------------------------------------------------------------------------------------
-- Users: expose and accept menu_version
-- ---------------------------------------------------------------------------------------------

create or replace function public.bot_user_json(u public.users, p_now timestamptz)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'chat_id', u.chat_id,
    'first_name', u.first_name,
    'lang', u.lang,
    'timezone', u.timezone,
    'utc_offset_min', (extract(epoch from ((p_now at time zone u.timezone) - (p_now at time zone 'UTC'))) / 60)::int,
    'remind_time', to_char(u.remind_time, 'HH24:MI'),
    'intervals', to_jsonb(u.intervals),
    'nudge_enabled', u.nudge_enabled,
    'nudge_time', to_char(u.nudge_time, 'HH24:MI'),
    'weekly_enabled', u.weekly_enabled,
    'onboarded', u.onboarded,
    'pending', u.pending,
    'is_active', u.is_active,
    'menu_version', u.menu_version,
    'local_date', to_char(p_now at time zone u.timezone, 'YYYY-MM-DD'),
    'local_time', to_char(p_now at time zone u.timezone, 'HH24:MI'),
    'local_dow', extract(dow from p_now at time zone u.timezone)::int
  )
$$;

create or replace function public.bot_set_user(p_chat_id bigint, p_patch jsonb, p_now timestamptz default now())
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  u public.users;
  v_tz text;
begin
  if p_patch ? 'timezone' then
    v_tz := public.bot_resolve_timezone(p_patch ->> 'timezone');
    if v_tz is null then
      raise exception 'unknown time zone: %', p_patch ->> 'timezone' using errcode = '22023';
    end if;
  end if;

  update public.users set
    lang           = case when p_patch ? 'lang' then p_patch ->> 'lang' else lang end,
    timezone       = coalesce(v_tz, timezone),
    remind_time    = case when p_patch ? 'remind_time' then (p_patch ->> 'remind_time')::time else remind_time end,
    intervals      = case when p_patch ? 'intervals'
                       then array(select distinct x::int from jsonb_array_elements_text(p_patch -> 'intervals') as x order by 1)
                       else intervals end,
    nudge_enabled  = case when p_patch ? 'nudge_enabled' then (p_patch ->> 'nudge_enabled')::boolean else nudge_enabled end,
    nudge_time     = case when p_patch ? 'nudge_time' then (p_patch ->> 'nudge_time')::time else nudge_time end,
    weekly_enabled = case when p_patch ? 'weekly_enabled' then (p_patch ->> 'weekly_enabled')::boolean else weekly_enabled end,
    onboarded      = case when p_patch ? 'onboarded' then (p_patch ->> 'onboarded')::boolean else onboarded end,
    pending        = case when p_patch ? 'pending' then p_patch ->> 'pending' else pending end,
    menu_version   = case when p_patch ? 'menu_version' then (p_patch ->> 'menu_version')::int else menu_version end
  where chat_id = p_chat_id
  returning * into u;

  if not found then
    raise exception 'unknown chat %', p_chat_id using errcode = 'P0002';
  end if;
  return public.bot_user_json(u, p_now);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Activity per local day, for the calendar and the weekly chart
-- ---------------------------------------------------------------------------------------------

-- [{d: 'YYYY-MM-DD', n: topics studied that day, r: reviews marked done that day}], only days
-- with something in them, for the last p_days local days (today included).
create function public.bot_activity(p_chat_id bigint, p_days int default 35, p_now timestamptz default now())
returns jsonb
language sql
stable
set search_path = ''
as $$
  with u as (
    select chat_id, timezone,
           (p_now at time zone timezone)::date as today,
           (p_now at time zone timezone)::date - (least(greatest(p_days, 1), 400) - 1) as first_day
    from public.users where chat_id = p_chat_id
  ),
  n as (
    select e.studied_on as d, count(*) as n
    from public.entries e, u
    where e.chat_id = u.chat_id and e.studied_on between u.first_day and u.today
    group by 1
  ),
  r as (
    select (rv.done_at at time zone u.timezone)::date as d, count(*) as r
    from public.reviews rv, u
    where rv.chat_id = u.chat_id and rv.done_at is not null
      and (rv.done_at at time zone u.timezone)::date between u.first_day and u.today
    group by 1
  )
  select coalesce((
    select jsonb_agg(jsonb_build_object('d', d, 'n', coalesce(n.n, 0), 'r', coalesce(r.r, 0)) order by d)
    from n full join r using (d)
  ), '[]'::jsonb)
$$;

-- ---------------------------------------------------------------------------------------------
-- Statistics: mastered topics and the badges already given
-- ---------------------------------------------------------------------------------------------

-- A topic is mastered once its last scheduled review is marked done.
create or replace function public.bot_stats(p_chat_id bigint, p_now timestamptz default now())
returns jsonb
language sql
stable
set search_path = ''
as $$
  with u as (
    select chat_id, timezone, achievements, (p_now at time zone timezone)::date as today
    from public.users where chat_id = p_chat_id
  )
  select public.bot_streak(p_chat_id, p_now) || jsonb_build_object(
    'entries_total', (select count(*) from public.entries e, u where e.chat_id = u.chat_id),
    'entries_week', (select count(*) from public.entries e, u where e.chat_id = u.chat_id and e.studied_on > u.today - 7),
    'first_day', (select min(e.studied_on) from public.entries e, u where e.chat_id = u.chat_id),
    'reviews_done', (select count(*) from public.reviews r, u where r.chat_id = u.chat_id and r.status = 'done'),
    'reviews_today', (
      select count(*) from public.reviews r, u
      where r.chat_id = u.chat_id and r.due_on <= u.today
        and (r.status = 'pending' or (r.status = 'sent' and (r.sent_at at time zone u.timezone)::date = u.today))
    ),
    'reviews_upcoming', (select count(*) from public.reviews r, u where r.chat_id = u.chat_id and r.status = 'pending' and r.due_on > u.today),
    'next_due', (select min(r.due_on) from public.reviews r, u where r.chat_id = u.chat_id and r.status = 'pending' and r.due_on > u.today),
    'mastered', (
      select count(*) from public.entries e, u
      where e.chat_id = u.chat_id and e.review_count > 0
        and exists (select 1 from public.reviews r where r.entry_id = e.id and r.step = e.review_count and r.status = 'done')
    ),
    'achievements', coalesce((select to_jsonb(achievements) from u), '[]'::jsonb)
  )
$$;

-- Records badges as given. Returns {new: codes that were not recorded before, all: every code}.
-- Two button presses at the same moment cannot both get the same badge as "new".
create function public.bot_claim_achievements(p_chat_id bigint, p_codes text[])
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_old text[];
  v_new text[];
begin
  select achievements into v_old from public.users where chat_id = p_chat_id for update;
  if not found then
    return jsonb_build_object('new', '[]'::jsonb, 'all', '[]'::jsonb);
  end if;

  select coalesce(array_agg(t.c order by t.ord), '{}') into v_new
  from (select c, min(ord) as ord from unnest(p_codes) with ordinality as x(c, ord) group by c) t
  where t.c <> all (v_old);

  if cardinality(v_new) > 0 then
    update public.users set achievements = v_old || v_new where chat_id = p_chat_id;
  end if;
  return jsonb_build_object('new', to_jsonb(v_new), 'all', to_jsonb(v_old || v_new));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Tick: weekly summaries now come with a picture
-- ---------------------------------------------------------------------------------------------

-- Same as before, except for the weekly part: it also returns the first name and the week's
-- activity (for the chart), and takes at most 5 chats per tick, because every summary means
-- drawing an image. The others follow in the next minutes.
create or replace function public.bot_tick_claim(p_now timestamptz default now(), p_test boolean default false)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_digests jsonb := '[]'::jsonb;
  v_nudges jsonb := '[]'::jsonb;
  v_weekly jsonb := '[]'::jsonb;
  v_ids jsonb;
  v_sum jsonb;
  r record;
begin
  -- Daily review reminder at remind_time.
  for r in
    update public.users u
       set last_digest_on = (p_now at time zone u.timezone)::date
     where u.is_active and u.onboarded
       and (case when p_test then u.chat_id < 0 else u.chat_id > 0 end)
       and (p_now at time zone u.timezone)::time >= u.remind_time
       and (u.last_digest_on is null or u.last_digest_on < (p_now at time zone u.timezone)::date)
    returning u.chat_id, u.lang, (p_now at time zone u.timezone)::date as today
  loop
    select jsonb_agg(rv.id order by rv.due_on, rv.id) into v_ids
    from public.reviews rv
    where rv.chat_id = r.chat_id and rv.status = 'pending' and rv.due_on <= r.today;
    if v_ids is not null then
      v_digests := v_digests || jsonb_build_array(jsonb_build_object('chat_id', r.chat_id, 'lang', r.lang, 'review_ids', v_ids));
    end if;
  end loop;

  -- Evening nudge at nudge_time when nothing was logged for today (not right after sign-up).
  for r in
    update public.users u
       set last_nudge_on = (p_now at time zone u.timezone)::date
     where u.is_active and u.onboarded and u.nudge_enabled
       and (case when p_test then u.chat_id < 0 else u.chat_id > 0 end)
       and (p_now at time zone u.timezone)::time >= u.nudge_time
       and (u.last_nudge_on is null or u.last_nudge_on < (p_now at time zone u.timezone)::date)
    returning u.chat_id, u.lang, u.created_at, (p_now at time zone u.timezone)::date as today
  loop
    if r.created_at <= p_now - interval '2 hours'
       and not exists (select 1 from public.entries e where e.chat_id = r.chat_id and e.studied_on = r.today) then
      v_nudges := v_nudges || jsonb_build_array(jsonb_build_object('chat_id', r.chat_id, 'lang', r.lang));
    end if;
  end loop;

  -- Weekly summary on Sundays from 20:00, only when the week had something in it.
  for r in
    update public.users u
       set last_weekly_on = (p_now at time zone u.timezone)::date
     where u.chat_id in (
       select w.chat_id
       from public.users w
       where w.is_active and w.onboarded and w.weekly_enabled
         and (case when p_test then w.chat_id < 0 else w.chat_id > 0 end)
         and extract(dow from (p_now at time zone w.timezone)) = 0
         and (p_now at time zone w.timezone)::time >= time '20:00'
         and (w.last_weekly_on is null or w.last_weekly_on < (p_now at time zone w.timezone)::date)
       order by w.chat_id
       limit 5
       for update skip locked
     )
    returning u.chat_id, u.lang, u.first_name
  loop
    v_sum := public.bot_week_summary(r.chat_id, p_now);
    if jsonb_array_length(v_sum -> 'entries') > 0 or (v_sum ->> 'reviews_due')::int > 0 then
      v_weekly := v_weekly || jsonb_build_array(jsonb_build_object(
        'chat_id', r.chat_id, 'lang', r.lang, 'first_name', r.first_name,
        'summary', v_sum, 'activity', public.bot_activity(r.chat_id, 7, p_now)));
    end if;
  end loop;

  return jsonb_build_object('digests', v_digests, 'nudges', v_nudges, 'weekly', v_weekly);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Permissions for the new functions (replaced functions keep theirs)
-- ---------------------------------------------------------------------------------------------

revoke all on function public.bot_activity(bigint, int, timestamptz) from public, anon, authenticated;
revoke all on function public.bot_claim_achievements(bigint, text[]) from public, anon, authenticated;
grant execute on function public.bot_activity(bigint, int, timestamptz) to service_role;
grant execute on function public.bot_claim_achievements(bigint, text[]) to service_role;
