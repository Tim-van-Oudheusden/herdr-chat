# Chats with an agent on another machine (README "Other machines", mods/chat/remote.js), sourced by
# run.sh after flows-subagent.sh (its helpers: chat_dumps, new_chat_since, term_field): flow `remote`.
# The "machine" is a second herdr-core session on this computer, reached through `hc machine add --via`
# with a home of its own (HOME=$M1HOME), so its host, registry, layout document and terminals are all
# that machine's, and the chat reaches the host through `herdr-chat-host tunnel` and `pipe`.
# 1. New chat in the machine's space: the host starts there, the chat connects through the tunnel, the
#    host's pane is hidden in that machine's document, and a turn comes back.
# 2. The orphan sweep (every 30 s, two passes) leaves that host alone while its chat is open.
# 3. Continue as chat on a Pi TUI there: the chat takes the TUI's place and has its session.
# 4. Open as chat on a sub-agent there: the dialog attaches to its host.
# 5. Closing the chat ends its host there.

if want remote; then
  step "remote: a machine reached through hc machine add --via (a second core session, a home of its own)"
  M1HOME="$BASE/m1home"; M1S="pcm1$$"; RPROJ="$BASE/remote-proj"
  mkdir -p "$M1HOME" "$RPROJ" && printf '# remote project\n' >"$RPROJ/README.md"
  # Not this run's app home: a machine has its own (its herdr-chat state, and no app socket of this one's).
  hc machine add --via "env -u HC_SESSION -u HERDR_APP_HOME -u HERDR_APP_BIN HOME=$M1HOME sh -c" --name m1 --session "$M1S" --install --json >>"$LOG" 2>&1 || fail "hc machine add m1"
  expect '[ "$(hc machine ls --json | python3 -c "import json,sys; print(next((m[\"state\"] for m in json.load(sys.stdin)[\"machines\"] if m[\"name\"] == \"m1\"), \"\"))")" = connected ]' "m1 is connected" 20
  # That machine's own core, read here directly: its layout document and its terminals' bare ids.
  m1hc() { env -u HC_SESSION HOME="$M1HOME" HC_SESSION="$M1S" hc "$@"; }
  m1_doc() { printf '%s\n%s\n' '{"jsonrpc":"2.0","id":1,"method":"hello","params":{"generation":1}}' '{"jsonrpc":"2.0","id":2,"method":"doc.get","params":{"name":"herdr-app"}}' | m1hc connect | python3 -c 'import json,sys
for l in sys.stdin:
    m = json.loads(l)
    if m.get("id") == 2: print(json.dumps(m["result"]["value"]))'; }
  # Whether terminal $1 (bare) has exactly one node in m1's document, hidden.
  m1_hidden() { m1_doc | python3 -c 'import json,sys
d = json.load(sys.stdin); hits = []
def walk(n):
    if (n.get("content") or {}).get("terminal") == sys.argv[1]: hits.append(bool(n.get("hidden")))
    for c in n.get("children") or []: walk(c)
for s in d.get("spaces", []):
    for t in s.get("tabs", []): walk(t.get("root") or {})
sys.exit(0 if hits == [True] else 1)' "$1"; }
  M1STATE="$M1HOME/.config/herdr-app/data/herdr-chat"
  inspect_m1() { "$REPO/bin/herdr-chat-host" inspect --chat "$1" --state-dir "$M1STATE" "${@:2}"; }
  # Its herdr-chat is this checkout; its Pi the fake, with a scenario (settings.json "machines", never config.json).
  python3 - "$STATE/settings.json" "$REPO" "$BASE" <<'PY'
import json, os, sys
p, repo, base = sys.argv[1:]
s = json.load(open(p)) if os.path.exists(p) else {}
s["machines"] = {"m1": {"host": f"{repo}/bin/herdr-chat-host", "pi": {"command": f"{repo}/tests/fake-pi/fake-pi.mjs", "tui": [f"{base}/fake-tui.sh"],
  "env": {"FAKE_PI_SCENARIO": f"{repo}/tests/fake-pi/scenarios/tools.json", "FAKE_PI_SPEED": "2", "FAKE_PI_LOG": f"{base}/fake-pi-m1.log", "PI_CODING_AGENT_DIR": f"{base}/pi-m1"}}}}
json.dump(s, open(p, "w"), indent=1)
PY
  "$NODE" "$REPO/install/layout.ts" install "$HERDR_APP_HOME" --app "$APP" >>"$LOG" 2>&1 || fail "install/layout.ts install"
  sleep 1
  MADE=$("$APP" do space.new --machine m1 --name remote --folder "$RPROJ") || fail "space.new on m1"
  RSPACE=$(echo "$MADE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["space"])')
  RSHELL=$(echo "$MADE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["terminal"])')
  [ "${RSPACE%%/*}" = m1 ] && [ "${RSHELL%%/*}" = m1 ] && ok "a space on m1 ($RSPACE, its shell $RSHELL)" || fail "the space isn't m1's: $MADE"

  step "remote 1: New chat in m1's space"
  BEFORE=$(chat_dumps)
  do_ pane.focus --terminal "$RSHELL"; sleep 0.5
  do_ new-chat.pi
  expect '[ -n "$(new_chat_since "$BEFORE")" ]' "a chat opened (its dump appeared)" 15
  R1=$(new_chat_since "$BEFORE")
  expect '[ "$(dbg "$R1" "d[\"connection\"][\"status\"]")" = connected ]' "it connected" 30
  [ -f "$M1STATE/chats/$R1.json" ] && [ ! -f "$STATE/chats/$R1.json" ] && ok "its registry is m1's, not this computer's" || fail "registry: m1 $(ls "$M1STATE/chats" 2>&1 | tr '\n' ' '), here $(ls "$STATE/chats" 2>&1 | tr '\n' ' ')"
  [ "$(dbg "$R1" "d[\"place\"][\"space\"]")" = "$RSPACE" ] && ok "the chat's place is m1's space (read from m1's document)" || fail "place: $(dbg "$R1" 'd["place"]')"
  RHOST="m1/$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["terminal"])' "$M1STATE/chats/$R1.json" 2>/dev/null)"
  [ "$(term_field "$RHOST" '(t.get("labels") or {}).get("herdr-chat.chat")')" = "$R1" ] && ok "its host runs on m1 ($RHOST, from m1's registry)" || fail "the chat's host: '$RHOST'"
  expect 'm1_hidden "${RHOST#m1/}"' "the host's pane is hidden in m1's layout document" 20
  expect '[ "$(m1hc get "${RHOST#m1/}" --json | python3 -c "import json,sys; print((json.load(sys.stdin).get(\"labels\") or {}).get(\"herdr.space\", \"\"))")" = "${RSPACE#m1/}" ]' "its herdr.space label is m1's bare space id" 10
  ls "$STATE/tunnels/"m1-*.json >>"$LOG" 2>&1 && ok "a tunnel to m1 runs (its state file here)" || fail "no tunnel state in $STATE/tunnels"
  cmd "type:Look around the repo"; cmd click:send
  expect 'inspect_m1 "$R1" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if d[\"state\"][\"phase\"] == \"idle\" and any(i[\"kind\"] == \"tool\" for i in d[\"items\"]) else 1)"' "the turn ran on m1 (a tool call, idle again)" 30
  expect '[ "$(dbg "$R1" "sum(1 for i in d[\"items\"] if i[\"kind\"] == \"assistant\")")" -ge 1 ]' "and its answer reached the chat through the tunnel" 10
  cmd "drop:$RPROJ/README.md"
  expect 'dbg "$R1" "d.get(\"flash\") or \"\"" | grep -q "runs on m1"' "a dropped file says the agent runs on m1" 5

  step "remote 2: the orphan sweep leaves m1's host alone while its chat is open"
  sleep 65
  [ "$(term_field "$RHOST" 't["state"]')" = live ] && ok "$RHOST still runs after two sweeps" || fail "$RHOST was ended: $(dbg "$R1" '"\n".join(d.get("log", [])[-15:])')"

  step "remote 3: Continue as chat on a Pi TUI on m1"
  TS="$M1HOME/tip-session.jsonl"
  python3 - "$TS" "$RPROJ" <<'PY'
import json, sys
path, cwd = sys.argv[1:]
ts = "2026-11-05T12:00:00.000Z"
u = {"role": "user", "content": [{"type": "text", "text": "asked on m1"}], "timestamp": 1}
a = {"role": "assistant", "content": [{"type": "text", "text": "Answered in m1's TUI."}], "api": "fake", "provider": "fake", "model": "fake",
     "usage": {"input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 2, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}, "stopReason": "stop", "timestamp": 2}
with open(path, "w") as f:
    f.write(json.dumps({"type": "session", "version": 3, "id": "tip-m1", "timestamp": ts, "cwd": cwd}) + "\n")
    f.write(json.dumps({"type": "message", "id": "m0", "parentId": None, "timestamp": ts, "message": u}) + "\n")
    f.write(json.dumps({"type": "message", "id": "m1", "parentId": "m0", "timestamp": ts, "message": a}) + "\n")
PY
  cat >"$BASE/fake-pi-m1-tui.mjs" <<'JS'
process.title = "pi";
const report = () => process.stdout.write("\x1b]7501;state=idle:app=pi\x1b\\");
report(); const every = setInterval(report, 500);
console.log("fake Pi TUI on m1");
process.on("SIGTERM", () => { clearInterval(every); setTimeout(() => process.exit(0), 300); });
JS
  OUT=$(hc run --on m1 --bg --json --keep --no-parent --cwd "$RPROJ" --label "herdr.space=${RSPACE#m1/}" --label herdr.tab=tbtipm1000 -- /bin/bash -lic "$NODE $BASE/fake-pi-m1-tui.mjs; exec /bin/bash -li" 2>>"$LOG") || fail "hc run --on m1 the TUI"
  RTIP=$(echo "$OUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["address"])')
  hc label "$RTIP" "herdr-chat.session=$TS" >>"$LOG" 2>&1 || fail "hc label $RTIP"
  expect 'app_sees_agent "$RTIP"' "the app knows $RTIP as an idle Pi" 15
  need '[ -n "$(term_field "$RTIP" "(t.get(\"foreground\") or {}).get(\"pid\")")" ]' "$RTIP has a foreground process" 10
  RPIPID=$(term_field "$RTIP" '(t.get("foreground") or {}).get("pid")')
  BEFORE=$(chat_dumps)
  do_ "new-chat.continue:$RTIP"
  expect '[ -n "$(new_chat_since "$BEFORE")" ]' "a chat opened" 15
  R3=$(new_chat_since "$BEFORE")
  expect '! kill -0 '"$RPIPID"' 2>/dev/null' "Pi on m1 (pid $RPIPID) quit on SIGTERM" 10
  expect '[ "$(term_field "$RTIP" "t[\"state\"]" 2>/dev/null)" != live ]' "the TUI's terminal on m1 is gone: its pane closed" 10
  expect '[ "$(dbg "$R3" "d[\"connection\"][\"status\"]")" = connected ]' "the chat connected" 30
  expect 'inspect_m1 "$R3" | grep -q "Answered in m1"' "the chat has the TUI session's history" 15
  # This chat's code views have been released under it here (the runtime's doing, now and then): render
  # must draw again without them, not fail on every frame. Released on purpose, then checked.
  sleep 1; cmd release-code
  expect '[ "$(dbg "$R3" "any(\"drawn again without them\" in l for l in d.get(\"log\", []))")" = true ]' "with its code views released, the chat draws again without them" 10
  expect no_mod_errors "and no render error stays" 5

  step "remote 4: Open as chat on a sub-agent on m1"
  # (With --on, the parent is named as m1's core knows it: bare.)
  SUB=$(hc run --on m1 --bg --json --parent "${RSHELL#m1/}" --name rsub --cwd "$RPROJ" -- /usr/bin/env "HERDR_CHAT_PI=$REPO/tests/fake-pi/fake-pi.mjs" \
    "FAKE_PI_SCENARIO=$REPO/tests/fake-pi/scenarios/tools.json" "PI_CODING_AGENT_DIR=$BASE/pi-m1" "$REPO/bin/herdr-chat-subagent" --provider pi 2>>"$LOG" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["address"])') || fail "hc run --on m1 a sub-agent"
  expect '[ -n "$(term_field "$SUB" "(t.get(\"labels\") or {}).get(\"herdr-chat.chat\")")" ]' "the sub-agent's host labeled itself" 15
  SUBCHAT=$(term_field "$SUB" 't["labels"]["herdr-chat.chat"]')
  # The app learns a label a moment after the core: until then a row's click is Herdr's own peek. Asked
  # again only while no chat dialog is open (a second ask replaces the dialog, leaving a stale dump).
  until_ 'overlay_open chat || { "$APP" do "chat-agents.peek:$SUB" >/dev/null; sleep 1.5; overlay_open chat; }' 15 || fail "no chat dialog for $SUB"
  expect '[ "$(dbg "$SUBCHAT.peek" "d[\"connection\"][\"status\"]")" = connected ]' "the peek dialog attached to its host on m1" 30
  cmd click:peek:close
  hc kill "$SUB" >>"$LOG" 2>&1 || true

  step "remote 4b: Continue as chat on a Pi TUI sub-agent on m1"
  # (A script named pi: a terminal running `node …/pi` is Pi's, as tuisub's in flows-subagent.sh.)
  mkdir -p "$BASE/tuibin-m1" && cp "$BASE/fake-pi-m1-tui.mjs" "$BASE/tuibin-m1/pi"
  # Its own session (step 3's chat still holds the first one): the same history, another file.
  TS2="$M1HOME/tip-session-sub.jsonl" && sed 's/"tip-m1"/"tip-m1-sub"/' "$TS" >"$TS2"
  OUT=$(hc run --on m1 --bg --json --parent "${RSHELL#m1/}" --name rtui --cwd "$RPROJ" -- "$NODE" "$BASE/tuibin-m1/pi" 2>>"$LOG") || fail "hc run --on m1 a TUI sub-agent"
  RSUBT=$(echo "$OUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["address"])')
  hc label "$RSUBT" "herdr-chat.session=$TS2" >>"$LOG" 2>&1 || fail "hc label $RSUBT"
  expect '[ "$(term_field "$RSUBT" "(t.get(\"status\") or {}).get(\"state\")")" = idle ]' "the TUI sub-agent on m1 is idle" 15
  # The app learns of a paneless terminal a moment after the core ("not live" until then): asked again until it goes.
  until_ '"$APP" do "new-chat.continue:$RSUBT" >/dev/null; sleep 2; [ "$(term_field "$RSUBT" "t[\"state\"]" 2>/dev/null)" != live ]' 20 && ok "the TUI sub-agent ended" || fail "the TUI sub-agent ended"
  until_ '[ -n "$(hc ls --json | python3 -c "import json,sys; print(next((t[\"address\"] for t in json.load(sys.stdin)[\"terminals\"] if t.get(\"name\") == \"rtui\" and t[\"state\"] == \"live\"), \"\"))")" ]' 10 || true
  NEXT=$(hc ls --json | python3 -c 'import json,sys; print(next((t["address"] for t in json.load(sys.stdin)["terminals"] if t.get("name") == "rtui" and t["state"] == "live"), ""))')
  [ "${NEXT%%/*}" = m1 ] && [ "$(term_field "$NEXT" 't.get("parent")')" = "$RSHELL" ] && ok "a chat host took its place on m1, same name and parent ($NEXT)" || fail "after Continue: '$NEXT' $(terms | tr '\n' '|')"
  NEXTCHAT=$(term_field "$NEXT" '(t.get("labels") or {}).get("herdr-chat.chat")')
  expect '[ "$(dbg "$NEXTCHAT.peek" "d[\"connection\"][\"status\"]")" = connected ]' "its chat dialog attached" 30
  expect 'inspect_m1 "$NEXTCHAT" | grep -q "Answered in m1"' "with the TUI session's history" 15
  cmd click:peek:close
  hc kill "$NEXT" >>"$LOG" 2>&1 || true

  expect no_mod_errors "no mod errors with m1's chats open" 3

  step "remote 5: closing the chat ends its host on m1"
  do_ tab.close --id "$(dbg "$R1" 'd["place"]["tab"]')" --confirmed true
  expect '[ "$(term_field "$RHOST" "t[\"state\"]" 2>/dev/null)" != live ]' "$RHOST ended with its chat (its pane watch, on m1's document)" 15
  do_ tab.close --id "$(dbg "$R3" 'd["place"]["tab"]')" --confirmed true
  m1hc server stop >>"$LOG" 2>&1 || true
  hc machine rm m1 >>"$LOG" 2>&1 || true
fi
