-- German Lesson Reminder bot: tables, logic and permissions.
--
-- The Edge Function (supabase/functions/reminder-bot) calls the bot_* functions below through
-- PostgREST RPC with the service role key. Every function takes the current time as p_now, so
-- tests and the ?action=simulate endpoint can replay any moment. Nothing here is readable or
-- callable with the anon/authenticated keys.

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table public.users (
  chat_id         bigint primary key,                       -- Telegram private chat id (= user id)
  first_name      text,
  username        text,
  language_code   text,                                     -- from Telegram, used for the first guess
  lang            text not null default 'ru' check (lang in ('ru', 'de')),
  timezone        text not null default 'Asia/Tashkent',
  remind_time     time not null default '09:00',
  intervals       int[] not null default '{1,3,7,14,30}'
                  check (cardinality(intervals) between 1 and 10 and 1 <= all (intervals) and 365 >= all (intervals)),
  nudge_enabled   boolean not null default true,            -- evening "what did you study today?"
  nudge_time      time not null default '21:00',
  weekly_enabled  boolean not null default true,            -- Sunday 20:00 summary
  onboarded       boolean not null default false,
  pending         text check (pending ~ '^(time|tz|evening|intervals)(:[os])?$'),  -- waiting for typed input
  is_active       boolean not null default true,            -- false after the user blocked the bot
  last_digest_on  date,                                     -- local dates of the last scheduled messages
  last_nudge_on   date,
  last_weekly_on  date,
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz
);

create table public.entries (
  id                bigint generated always as identity primary key,
  chat_id           bigint not null references public.users (chat_id) on delete cascade,
  studied_on        date not null,
  content           text not null check (length(content) between 1 and 2000),
  source_message_id bigint,                                 -- the user's Telegram message
  item_no           int not null default 1,                 -- position when one message holds several entries
  reply_message_id  bigint,                                 -- the bot's confirmation message
  review_count      int not null default 0,
  created_at        timestamptz not null default now(),
  unique (chat_id, source_message_id, item_no)
);
create index entries_chat_studied_idx on public.entries (chat_id, studied_on desc);

create table public.reviews (
  id        bigint generated always as identity primary key,
  entry_id  bigint not null references public.entries (id) on delete cascade,
  chat_id   bigint not null references public.users (chat_id) on delete cascade,
  step      int not null,                                   -- 1..entries.review_count
  due_on    date not null,                                  -- local date
  status    text not null default 'pending' check (status in ('pending', 'sent', 'done')),
  sent_at   timestamptz,
  done_at   timestamptz,
  unique (entry_id, step)
);
create index reviews_pending_idx on public.reviews (chat_id, due_on) where status = 'pending';
create index reviews_entry_idx on public.reviews (entry_id);
create index reviews_chat_status_idx on public.reviews (chat_id, status);

-- One reminder message ("digest") and the reviews it lists, so its buttons keep working.
create table public.digests (
  id          bigint generated always as identity primary key,
  chat_id     bigint not null references public.users (chat_id) on delete cascade,
  local_date  date not null,
  review_ids  bigint[] not null,
  message_id  bigint,
  created_at  timestamptz not null default now()
);
create index digests_chat_idx on public.digests (chat_id, id desc);

-- Small key/value store: cron secret, tick URL, webhook status, last tick result.
create table public.app_state (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Secret the every-minute cron job sends to the Edge Function (never leaves the database/server).
insert into public.app_state (key, value)
values ('cron', jsonb_build_object('secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')))
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------------------------
-- Users and settings
-- ---------------------------------------------------------------------------------------------

create function public.bot_user_json(u public.users, p_now timestamptz)
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
    'local_date', to_char(p_now at time zone u.timezone, 'YYYY-MM-DD'),
    'local_time', to_char(p_now at time zone u.timezone, 'HH24:MI'),
    'local_dow', extract(dow from p_now at time zone u.timezone)::int
  )
$$;

-- Creates the user on first contact, refreshes the profile afterwards. Returns settings + local clock.
create function public.bot_touch_user(
  p_chat_id bigint,
  p_first_name text default null,
  p_username text default null,
  p_language_code text default null,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  u public.users;
begin
  insert into public.users as t (chat_id, first_name, username, language_code, lang, created_at, last_seen_at)
  values (
    p_chat_id, left(p_first_name, 100), left(p_username, 100), left(p_language_code, 10),
    case when lower(coalesce(p_language_code, '')) like 'de%' then 'de' else 'ru' end,
    p_now, p_now
  )
  on conflict (chat_id) do update
    set first_name = excluded.first_name,
        username = excluded.username,
        language_code = excluded.language_code,
        last_seen_at = excluded.last_seen_at,
        is_active = true
  returning * into u;
  return public.bot_user_json(u, p_now);
end;
$$;

-- "tashkent", "Europe/Berlin", "new york" -> canonical IANA name, or null.
create function public.bot_resolve_timezone(p_name text)
returns text
language sql
stable
set search_path = ''
as $$
  with q as (select lower(replace(trim(p_name), ' ', '_')) as v)
  select n.name
  from pg_catalog.pg_timezone_names n, q
  where n.name !~* '^(posix|right)/'
    and (lower(n.name) = q.v
         or (n.name !~* '^etc/' and n.name like '%/%' and lower(regexp_replace(n.name, '^.*/', '')) = q.v))
  order by (lower(n.name) = q.v) desc, length(n.name), n.name
  limit 1
$$;

-- Applies a settings patch: lang, timezone, remind_time, intervals, nudge_enabled, nudge_time,
-- weekly_enabled, onboarded, pending. Unknown time zones raise 22023.
create function public.bot_set_user(p_chat_id bigint, p_patch jsonb, p_now timestamptz default now())
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
    pending        = case when p_patch ? 'pending' then p_patch ->> 'pending' else pending end
  where chat_id = p_chat_id
  returning * into u;

  if not found then
    raise exception 'unknown chat %', p_chat_id using errcode = 'P0002';
  end if;
  return public.bot_user_json(u, p_now);
end;
$$;

create function public.bot_deactivate(p_chat_id bigint)
returns jsonb
language sql
set search_path = ''
as $$
  update public.users set is_active = false where chat_id = p_chat_id;
  select jsonb_build_object('ok', true);
$$;

-- ---------------------------------------------------------------------------------------------
-- Entries (what was studied) and their scheduled reviews
-- ---------------------------------------------------------------------------------------------

-- p_items: [{studied_on: 'YYYY-MM-DD', content: text, due_dates: ['YYYY-MM-DD', ...]}, ...]
-- A repeated Telegram delivery of the same message returns {duplicate: true} and changes nothing.
-- p_replace = true first deletes the entries of that message (used when the user edits it).
create function public.bot_add_entries(
  p_chat_id bigint,
  p_source_message_id bigint,
  p_items jsonb,
  p_replace boolean default false
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_item jsonb;
  v_no int := 0;
  v_id bigint;
  v_dates jsonb;
  v_out jsonb := '[]'::jsonb;
begin
  if p_replace and p_source_message_id is not null then
    delete from public.entries where chat_id = p_chat_id and source_message_id = p_source_message_id;
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_no := v_no + 1;
    v_dates := coalesce(v_item -> 'due_dates', '[]'::jsonb);

    insert into public.entries (chat_id, studied_on, content, source_message_id, item_no, review_count)
    values (p_chat_id, (v_item ->> 'studied_on')::date, v_item ->> 'content', p_source_message_id, v_no,
            jsonb_array_length(v_dates))
    on conflict (chat_id, source_message_id, item_no) do nothing
    returning id into v_id;

    if v_id is null then
      return jsonb_build_object('duplicate', true, 'entries', '[]'::jsonb);
    end if;

    insert into public.reviews (entry_id, chat_id, step, due_on)
    select v_id, p_chat_id, t.ord, t.d::date
    from jsonb_array_elements_text(v_dates) with ordinality as t(d, ord);

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', v_id,
      'studied_on', v_item ->> 'studied_on',
      'content', v_item ->> 'content',
      'due_dates', v_dates
    ));
  end loop;

  return jsonb_build_object('duplicate', false, 'entries', v_out);
end;
$$;

create function public.bot_set_reply(p_chat_id bigint, p_source_message_id bigint, p_reply_message_id bigint)
returns jsonb
language sql
set search_path = ''
as $$
  update public.entries set reply_message_id = p_reply_message_id
  where chat_id = p_chat_id and source_message_id = p_source_message_id;
  select jsonb_build_object('ok', true);
$$;

-- Entries created from one user message, and whether any of their reviews was already sent.
create function public.bot_source_entries(p_chat_id bigint, p_source_message_id bigint)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', e.id, 'studied_on', e.studied_on, 'content', e.content,
               'reply_message_id', e.reply_message_id, 'review_count', e.review_count)
             order by e.item_no)
      from public.entries e
      where e.chat_id = p_chat_id and e.source_message_id = p_source_message_id
    ), '[]'::jsonb),
    'started', exists (
      select 1
      from public.reviews r
      join public.entries e on e.id = r.entry_id
      where e.chat_id = p_chat_id and e.source_message_id = p_source_message_id and r.status <> 'pending'
    )
  )
$$;

create function public.bot_update_entry(p_chat_id bigint, p_entry_id bigint, p_content text)
returns jsonb
language sql
set search_path = ''
as $$
  update public.entries set content = p_content where chat_id = p_chat_id and id = p_entry_id;
  select jsonb_build_object('ok', true);
$$;

create function public.bot_get_entry(p_chat_id bigint, p_entry_id bigint)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce((
    select jsonb_build_object('id', e.id, 'studied_on', e.studied_on, 'content', e.content)
    from public.entries e
    where e.chat_id = p_chat_id and e.id = p_entry_id
  ), 'null'::jsonb)
$$;

-- Deletes one entry (p_entry_id) or all entries of one user message (p_source_message_id).
create function public.bot_delete_entries(
  p_chat_id bigint,
  p_entry_id bigint default null,
  p_source_message_id bigint default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  n int;
begin
  delete from public.entries
  where chat_id = p_chat_id
    and ((p_entry_id is not null and id = p_entry_id)
         or (p_source_message_id is not null and source_message_id = p_source_message_id));
  get diagnostics n = row_count;
  return jsonb_build_object('deleted', n);
end;
$$;

create function public.bot_list_entries(p_chat_id bigint, p_limit int default 15)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'total', (select count(*) from public.entries where chat_id = p_chat_id),
    'items', coalesce((
      select jsonb_agg(x order by x.studied_on desc, x.id desc)
      from (
        select e.id, e.studied_on, e.content, e.review_count as total,
               (select count(*) from public.reviews r where r.entry_id = e.id and r.status = 'done') as done,
               (select min(r.due_on) from public.reviews r where r.entry_id = e.id and r.status = 'pending') as next_due
        from public.entries e
        where e.chat_id = p_chat_id
        order by e.studied_on desc, e.id desc
        limit least(greatest(p_limit, 1), 50)
      ) x
    ), '[]'::jsonb)
  )
$$;

-- ---------------------------------------------------------------------------------------------
-- Reminder messages (digests)
-- ---------------------------------------------------------------------------------------------

-- Reviews to show for /today: not yet sent and due, or sent today and not done yet.
create function public.bot_due_today(p_chat_id bigint, p_now timestamptz default now())
returns jsonb
language sql
stable
set search_path = ''
as $$
  with u as (
    select chat_id, timezone, (p_now at time zone timezone)::date as today
    from public.users where chat_id = p_chat_id
  )
  select jsonb_build_object(
    'review_ids', coalesce((
      select jsonb_agg(r.id order by r.due_on, r.id)
      from public.reviews r, u
      where r.chat_id = u.chat_id and r.due_on <= u.today
        and (r.status = 'pending' or (r.status = 'sent' and (r.sent_at at time zone u.timezone)::date = u.today))
    ), '[]'::jsonb),
    'next_due', (
      select min(r.due_on) from public.reviews r, u
      where r.chat_id = u.chat_id and r.status = 'pending' and r.due_on > u.today
    )
  )
$$;

-- The digest with the current state of each review (null when it does not belong to the chat).
create function public.bot_digest_view(p_chat_id bigint, p_digest_id bigint, p_now timestamptz default now())
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce((
    select jsonb_build_object(
      'id', d.id,
      'local_date', d.local_date,
      'today', (p_now at time zone u.timezone)::date,
      'message_id', d.message_id,
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'review_id', r.id, 'step', r.step, 'total', e.review_count, 'due_on', r.due_on,
                 'status', r.status, 'studied_on', e.studied_on, 'content', e.content)
               order by t.ord)
        from unnest(d.review_ids) with ordinality as t(rid, ord)
        join public.reviews r on r.id = t.rid
        join public.entries e on e.id = r.entry_id
      ), '[]'::jsonb)
    )
    from public.digests d
    join public.users u on u.chat_id = d.chat_id
    where d.id = p_digest_id and d.chat_id = p_chat_id
  ), 'null'::jsonb)
$$;

create function public.bot_create_digest(p_chat_id bigint, p_review_ids bigint[], p_now timestamptz default now())
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_id bigint;
begin
  insert into public.digests (chat_id, local_date, review_ids)
  select u.chat_id, (p_now at time zone u.timezone)::date, p_review_ids
  from public.users u where u.chat_id = p_chat_id
  returning id into v_id;
  return public.bot_digest_view(p_chat_id, v_id, p_now);
end;
$$;

create function public.bot_digest_sent(p_digest_id bigint, p_message_id bigint, p_now timestamptz default now())
returns jsonb
language sql
set search_path = ''
as $$
  update public.digests set message_id = p_message_id where id = p_digest_id;
  update public.reviews set status = 'sent', sent_at = p_now
  where status = 'pending'
    and id = any (coalesce((select review_ids from public.digests where id = p_digest_id), '{}'));
  select jsonb_build_object('ok', true);
$$;

-- Sending failed: forget the digest; p_release lets the next tick try again today.
create function public.bot_digest_failed(p_digest_id bigint, p_release boolean default false)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_chat bigint;
begin
  delete from public.digests where id = p_digest_id returning chat_id into v_chat;
  if p_release and v_chat is not null then
    update public.users set last_digest_on = null where chat_id = v_chat;
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- Buttons under a digest: 'done' (one review), 'done_all', 'snooze' (rest -> tomorrow).
-- Returns the updated digest view plus {changed, streak}.
create function public.bot_review_action(
  p_chat_id bigint,
  p_digest_id bigint,
  p_action text,
  p_review_id bigint default null,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_ids bigint[];
  v_today date;
  v_changed int := 0;
begin
  select d.review_ids, (p_now at time zone u.timezone)::date
    into v_ids, v_today
  from public.digests d
  join public.users u on u.chat_id = d.chat_id
  where d.id = p_digest_id and d.chat_id = p_chat_id;

  if v_ids is null then
    return 'null'::jsonb;
  end if;

  if p_action = 'done' then
    update public.reviews set status = 'done', done_at = p_now
    where id = p_review_id and id = any (v_ids) and chat_id = p_chat_id and status <> 'done';
  elsif p_action = 'done_all' then
    update public.reviews set status = 'done', done_at = p_now
    where id = any (v_ids) and chat_id = p_chat_id
      and (status = 'sent' or (status = 'pending' and due_on <= v_today));
  elsif p_action = 'snooze' then
    update public.reviews set status = 'pending', due_on = v_today + 1, sent_at = null
    where id = any (v_ids) and chat_id = p_chat_id
      and (status = 'sent' or (status = 'pending' and due_on <= v_today));
  else
    raise exception 'unknown action %', p_action using errcode = '22023';
  end if;
  get diagnostics v_changed = row_count;

  return public.bot_digest_view(p_chat_id, p_digest_id, p_now)
      || jsonb_build_object('changed', v_changed, 'streak', public.bot_streak(p_chat_id, p_now));
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Statistics
-- ---------------------------------------------------------------------------------------------

-- A day counts when something was studied that day or a review was marked done.
create function public.bot_streak(p_chat_id bigint, p_now timestamptz default now())
returns jsonb
language sql
stable
set search_path = ''
as $$
  with u as (
    select chat_id, timezone, (p_now at time zone timezone)::date as today
    from public.users where chat_id = p_chat_id
  ),
  days as (
    select e.studied_on as d from public.entries e, u where e.chat_id = u.chat_id and e.studied_on <= u.today
    union
    select (r.done_at at time zone u.timezone)::date from public.reviews r, u
    where r.chat_id = u.chat_id and r.done_at is not null
  ),
  islands as (
    select max(d) as last_day, count(*) as len
    from (select d, d - (row_number() over (order by d))::int as grp from days) s
    group by grp
  )
  select jsonb_build_object(
    'current', coalesce((select i.len from islands i, u where i.last_day >= u.today - 1 order by i.last_day desc limit 1), 0),
    'best', coalesce((select max(len) from islands), 0),
    'active_days', (select count(*) from days),
    'active_today', exists (select 1 from days, u where days.d = u.today)
  )
$$;

create function public.bot_stats(p_chat_id bigint, p_now timestamptz default now())
returns jsonb
language sql
stable
set search_path = ''
as $$
  with u as (
    select chat_id, timezone, (p_now at time zone timezone)::date as today
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
    'next_due', (select min(r.due_on) from public.reviews r, u where r.chat_id = u.chat_id and r.status = 'pending' and r.due_on > u.today)
  )
$$;

-- The last 7 local days (today included).
create function public.bot_week_summary(p_chat_id bigint, p_now timestamptz default now())
returns jsonb
language sql
stable
set search_path = ''
as $$
  with w as (
    select chat_id, timezone, (p_now at time zone timezone)::date - 6 as d_from, (p_now at time zone timezone)::date as d_to
    from public.users where chat_id = p_chat_id
  )
  select public.bot_streak(p_chat_id, p_now) || jsonb_build_object(
    'from', (select d_from from w),
    'to', (select d_to from w),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object('studied_on', e.studied_on, 'content', e.content) order by e.studied_on, e.id)
      from public.entries e, w
      where e.chat_id = w.chat_id and e.studied_on between w.d_from and w.d_to
    ), '[]'::jsonb),
    'week_days', (
      select count(*) from (
        select e.studied_on as d from public.entries e, w
        where e.chat_id = w.chat_id and e.studied_on between w.d_from and w.d_to
        union
        select (r.done_at at time zone w.timezone)::date from public.reviews r, w
        where r.chat_id = w.chat_id and r.done_at is not null
          and (r.done_at at time zone w.timezone)::date between w.d_from and w.d_to
      ) x
    ),
    'reviews_due', (
      select count(*) from public.reviews r, w
      where r.chat_id = w.chat_id and r.due_on between w.d_from and w.d_to
    ),
    'reviews_done', (
      select count(*) from public.reviews r, w
      where r.chat_id = w.chat_id and r.due_on between w.d_from and w.d_to and r.status = 'done'
    )
  )
$$;

-- ---------------------------------------------------------------------------------------------
-- Every-minute tick: claim what is due right now (each claim happens once per local day)
-- ---------------------------------------------------------------------------------------------

-- Returns {digests: [{chat_id, lang, review_ids}], nudges: [{chat_id, lang}], weekly: [{chat_id, lang, summary}]}.
-- p_test = true works only on test chats (negative ids), false only on real ones.
create function public.bot_tick_claim(p_now timestamptz default now(), p_test boolean default false)
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
     where u.is_active and u.onboarded and u.weekly_enabled
       and (case when p_test then u.chat_id < 0 else u.chat_id > 0 end)
       and extract(dow from (p_now at time zone u.timezone)) = 0
       and (p_now at time zone u.timezone)::time >= time '20:00'
       and (u.last_weekly_on is null or u.last_weekly_on < (p_now at time zone u.timezone)::date)
    returning u.chat_id, u.lang
  loop
    v_sum := public.bot_week_summary(r.chat_id, p_now);
    if jsonb_array_length(v_sum -> 'entries') > 0 or (v_sum ->> 'reviews_due')::int > 0 then
      v_weekly := v_weekly || jsonb_build_array(jsonb_build_object('chat_id', r.chat_id, 'lang', r.lang, 'summary', v_sum));
    end if;
  end loop;

  return jsonb_build_object('digests', v_digests, 'nudges', v_nudges, 'weekly', v_weekly);
end;
$$;

-- A send failed temporarily: let the next tick try again.
create function public.bot_release_claim(p_chat_id bigint, p_kind text)
returns jsonb
language sql
set search_path = ''
as $$
  update public.users set
    last_digest_on = case when p_kind = 'digest' then null else last_digest_on end,
    last_nudge_on  = case when p_kind = 'nudge' then null else last_nudge_on end,
    last_weekly_on = case when p_kind = 'weekly' then null else last_weekly_on end
  where chat_id = p_chat_id;
  select jsonb_build_object('ok', true);
$$;

-- ---------------------------------------------------------------------------------------------
-- App state and maintenance
-- ---------------------------------------------------------------------------------------------

create function public.bot_get_state(p_key text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce((select value from public.app_state where key = p_key), 'null'::jsonb)
$$;

create function public.bot_set_state(p_key text, p_value jsonb)
returns jsonb
language sql
set search_path = ''
as $$
  insert into public.app_state (key, value, updated_at) values (p_key, p_value, now())
  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;
  select jsonb_build_object('ok', true);
$$;

-- Removes the test chats used by tests and ?action=simulate (negative chat ids).
create function public.bot_test_cleanup()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  n int;
begin
  delete from public.users where chat_id < 0;
  get diagnostics n = row_count;
  return jsonb_build_object('deleted_users', n);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Permissions: only the service role (Edge Function) may touch any of this.
-- ---------------------------------------------------------------------------------------------

alter table public.users enable row level security;
alter table public.entries enable row level security;
alter table public.reviews enable row level security;
alter table public.digests enable row level security;
alter table public.app_state enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- Objects created later in this schema are private by default too.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
