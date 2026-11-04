-- Every minute pg_cron asks the Edge Function to send whatever is due (reminders, evening nudges,
-- weekly summaries) and to connect the Telegram webhook once BOT_TOKEN exists.
--
-- One-time step after deploying the function (the URL of this project):
--   select public.bot_configure('https://<project-ref>.supabase.co/functions/v1/reminder-bot');

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

create function public.bot_configure(p_function_url text)
returns jsonb
language sql
set search_path = ''
as $$
  insert into public.app_state (key, value, updated_at)
  values ('tick', jsonb_build_object('url', rtrim(p_function_url, '/') || '?action=tick'), now())
  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;
  select value from public.app_state where key = 'tick';
$$;

create function public.bot_tick_request()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  select value ->> 'url' into v_url from public.app_state where key = 'tick';
  select value ->> 'secret' into v_secret from public.app_state where key = 'cron';
  if v_url is null or v_secret is null then
    return null;
  end if;
  return net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    timeout_milliseconds := 55000
  );
end;
$$;

-- Only the database owner (and pg_cron, which runs as the owner) may call these two.
revoke all on function public.bot_configure(text) from public, anon, authenticated, service_role;
revoke all on function public.bot_tick_request() from public, anon, authenticated, service_role;

select cron.schedule('reminder-bot-tick', '* * * * *', 'select public.bot_tick_request()');
