import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { ConductRules } from './domain/negotiation-room';
import { buildAgentCli, parseHash } from './domain/room-link';

// Веб-интерфейс Арены. Люди вводят условия и наблюдают; торгуют только CLI-агенты.
//
// Экраны (hash-роутинг):
//  #/                              — создать комнату (человек A)
//  #r=<id>&owner=<token>            — страница владельца стороны: свои условия + agent-ссылка + лента
//  #r=<id>&invite=<token>           — инвайт оппонента: обмен на owner-ссылку стороны B
//  #r=<id>&agent=<SIDE>&token=<t>   — страница для агента: инструкции + CLI-команда
//  #r=<id>                          — наблюдатель (оба человека): только публичная лента

type OfferStatus = 'PROPOSE' | 'ACCEPT' | 'REJECT';
type Side = 'SIDE_A' | 'SIDE_B';

type RoomMessage = {
  id: string;
  side: Side;
  offer: { price: number; currency: string; status: OfferStatus; accepts?: string };
  message: string;
  createdAt: string;
};

type PublicSnapshot = {
  type: 'room_state';
  roomId: string;
  lotTitle: string;
  status: 'WAITING_FOR_SUBMISSIONS' | 'IN_NEGOTIATION' | 'DEAL_AGREED' | 'FAILED';
  nextTurn: Side;
  rounds: number;
  maxRounds: number;
  submitted: { SIDE_A: boolean; SIDE_B: boolean };
  agentOnline: { SIDE_A: boolean; SIDE_B: boolean };
  messages: RoomMessage[];
  result:
    | { status: 'DEAL_AGREED'; price: number; currency: string; acceptedBy: string }
    | { status: 'FAILED'; reason: string }
    | null;
};

type OwnerSnapshot = PublicSnapshot & {
  role: Side;
  ownConditions: { text: string; desiredPrice?: number; walkAwayPrice?: number } | null;
  ownSubmitted: boolean;
  otherSubmitted: boolean;
  agentToken: string;
  agentHash: string;
  inviteHash: string | null;
};

const STATUS_LABEL: Record<PublicSnapshot['status'], string> = {
  WAITING_FOR_SUBMISSIONS: 'Ожидание условий',
  IN_NEGOTIATION: 'Торг идёт',
  DEAL_AGREED: 'Сделка согласована',
  FAILED: 'Без сделки',
};

const wsOrigin = () => window.location.origin.replace(/^http/, 'ws');

function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return useMemo(() => parseHash(hash), [hash]);
}

function useCopy(): [(key: string, text: string) => Promise<void>, string | null] {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = useCallback(async (key: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    window.setTimeout(() => setCopied(null), 1600);
  }, []);
  return [copy, copied];
}

/** Публичная лента комнаты: SSE + fallback polling. */
function usePublicRoom(roomId: string | null) {
  const [snapshot, setSnapshot] = useState<PublicSnapshot | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!roomId) return;
    let alive = true;
    let source: EventSource | null = null;
    const load = async () => {
      try {
        const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`);
        if (!res.ok) {
          if (alive) setError('Комната не найдена. Возможно, сервер перезапустился.');
          return;
        }
        if (alive) {
          setSnapshot((await res.json()) as PublicSnapshot);
          setError('');
        }
      } catch {
        if (alive) setError('Нет связи с сервером. Запустите `npm run dev:api`.');
      }
    };
    load();
    try {
      source = new EventSource(`/api/rooms/${encodeURIComponent(roomId)}/stream`);
      source.addEventListener('room_state', (event) => {
        if (!alive) return;
        try {
          setSnapshot(JSON.parse((event as MessageEvent).data) as PublicSnapshot);
        } catch { /* noop */ }
      });
      source.onerror = () => source?.close();
    } catch { /* polling only */ }
    const timer = window.setInterval(load, 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
      source?.close();
    };
  }, [roomId]);
  return { snapshot, error };
}

function Transcript({ messages }: { messages: RoomMessage[] }) {
  if (messages.length === 0) {
    return (
      <div className="empty-state">
        <strong>Пока тихо.</strong>
        <span>Ходы агентов появятся здесь автоматически.</span>
      </div>
    );
  }
  return (
    <div className="message-list" role="log" aria-live="polite">
      {messages.map((item, index) => (
        <div className={`message-row ${item.side === 'SIDE_A' ? 'message-side-a' : 'message-side-b'}`} key={item.id}>
          <div className="agent-avatar">{item.side === 'SIDE_A' ? 'A' : 'B'}</div>
          <div className="message-content">
            <div className="message-meta">
              <strong>{item.side === 'SIDE_A' ? 'Агент A' : 'Агент B'}</strong>
              <span>ход {index + 1} · {item.offer.status}</span>
            </div>
            <p><b>{item.offer.price} {item.offer.currency}</b> — {item.message}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function ResultBanner({ result }: { result: PublicSnapshot['result'] }) {
  if (!result) return null;
  if (result.status === 'DEAL_AGREED') {
    return <div className="result-banner">DEAL_AGREED — {result.price} {result.currency} · принял {result.acceptedBy}</div>;
  }
  return <div className="result-banner">FAILED — {result.reason}</div>;
}

function CopyField({ label, value, copyKey, href }: { label: string; value: string; copyKey: string; href?: string }) {
  const [copy, copied] = useCopy();
  return (
    <div className="role-link">
      <span>{label}</span>
      {href
        ? <a className="link-value" href={href} target="_blank" rel="noreferrer" title={value}>{value}</a>
        : <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} />}
      <button className="secondary-button" type="button" onClick={() => copy(copyKey, value)}>{copied === copyKey ? 'Скопировано' : 'Копировать'}</button>
    </div>
  );
}

// --- Экран 1: создание комнаты (человек A) ---
function HomeView() {
  const [lotTitle, setLotTitle] = useState('');
  const [maxRounds, setMaxRounds] = useState('20');
  const [created, setCreated] = useState<{ roomId: string; ownerUrlA: string; inviteUrl: string; observerUrl: string } | null>(null);
  const [notice, setNotice] = useState('');

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setNotice('Создаём комнату...');
    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ origin: window.location.origin, lotTitle: lotTitle.trim(), maxRounds: Number(maxRounds) || 20 }),
      });
      const payload = await res.json();
      if (!res.ok) {
        setNotice(payload.error ?? 'Не удалось создать комнату.');
        return;
      }
      // Сразу открываем мою комнату: всё нужное (инвайт, агент) — внутри неё.
      try {
        const token = new URL(payload.ownerUrlA).hash.match(/owner=([^&]+)/)?.[1];
        if (!token) throw new Error('no owner token');
        window.location.hash = `r=${payload.roomId}&owner=${token}`;
        return;
      } catch {
        setCreated(payload);
        setNotice('Комната создана, но открыть её автоматически не вышло — ссылки ниже.');
      }
    } catch {
      setNotice('Нет связи с сервером. Запустите `npm run dev:api`.');
    }
  };

  return (
    <>
      <section className="welcome-panel">
        <p className="section-kicker">ШАГ 1 — КОМНАТА</p>
        <h2>Создайте арену переговоров</h2>
        <form onSubmit={create}>
          <label>Предмет сделки (лот)<input value={lotTitle} placeholder="Например: ноутбук ThinkPad" onChange={(e) => setLotTitle(e.target.value)} /></label>
          <label>Лимит раундов<input type="number" min={2} max={100} value={maxRounds} onChange={(e) => setMaxRounds(e.target.value)} /></label>
          <button className="primary-button" type="submit" style={{ marginTop: 16 }}>Создать комнату</button>
        </form>
        {notice && <div className="notice" style={{ marginTop: 12 }}>{notice}</div>}
      </section>
      {created && (
        <section className="links-panel">
          <p className="section-kicker">ШАГ 2 — ССЫЛКИ</p>
          <h2>Три ссылки на комнату</h2>
          <div className="link-grid">
            <CopyField label="Моя (A)" value={created.ownerUrlA} copyKey="a" href={created.ownerUrlA} />
            <CopyField label="Опоненту" value={created.inviteUrl} copyKey="inv" href={created.inviteUrl} />
            <CopyField label="Наблюдать" value={created.observerUrl} copyKey="obs" href={created.observerUrl} />
          </div>
          <p className="panel-help">Откройте «Мою» ссылку и введите свои условия. Инвайт отправьте оппоненту.</p>
        </section>
      )}
    </>
  );
}

// --- Экран 2: владелец стороны (A или B) ---
function OwnerView({ roomId, owner }: { roomId: string; owner: string }) {
  const [view, setView] = useState<OwnerSnapshot | null>(null);
  const [error, setError] = useState('');
  const [terms, setTerms] = useState('');
  const [whisper, setWhisper] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/view?owner=${encodeURIComponent(owner)}`);
      const payload = await res.json();
      if (!res.ok) {
        setError(payload.error ?? 'Нет доступа.');
        return;
      }
      setView(payload as OwnerSnapshot);
    } catch {
      setError('Нет связи с сервером.');
    }
  }, [roomId, owner]);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 3000);
    return () => window.clearInterval(timer);
  }, [load]);

  const submit = async (e: FormEvent) => {    e.preventDefault();
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/conditions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          owner,
          origin: window.location.origin,
          conditions: { text: terms.trim() },
        }),
      });
      const payload = await res.json();
      if (!res.ok) {
        setError(payload.error ?? 'Не удалось сохранить.');
        return;
      }
      setError('');
      await load();
    } catch {
      setError('Нет связи с сервером.');
    }
  };

  const sendWhisper = async (e: FormEvent) => {
    e.preventDefault();
    if (!whisper.trim()) return;
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/whisper`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner, text: whisper.trim() }),
      });
      const payload = await res.json();
      if (!res.ok) {
        setError(payload.error ?? 'Не удалось шепнуть.');
        return;
      }
      setWhisper('');
      setError('');
      await load();
    } catch {
      setError('Нет связи с сервером.');
    }
  };

  if (error && !view) return <section className="welcome-panel"><h2>Нет доступа</h2><p>{error}</p></section>;
  if (!view) return <section className="welcome-panel"><p>Загружаем комнату...</p></section>;

  const agentUrl = `${window.location.origin}/${view.agentHash}`;
  const agentCli = buildAgentCli(wsOrigin(), roomId, view.role, view.agentToken);
  const briefUrl = `${window.location.origin}/a/${encodeURIComponent(roomId)}/${view.role}/${encodeURIComponent(view.agentToken)}`;
  const inviteUrl = view.inviteHash ? `${window.location.origin}/${view.inviteHash}` : null;

  return (
    <>
      <section className="conditions-panel">
        <div className="card-heading">
          <div>
            <p className="section-kicker">МОИ УСЛОВИЯ · ПРИВАТНО</p>
            <h2>{view.role === 'SIDE_A' ? 'Сторона A · Покупатель' : 'Сторона B · Продавец'}{view.lotTitle ? ` — ${view.lotTitle}` : ''}</h2>
          </div>
          <span className="role-badge">{view.role}</span>
        </div>
        {!view.ownSubmitted ? (
          <form onSubmit={submit}>
            <p className="panel-help">Опишите сделку своими словами: что покупаете/продаёте, цена, пределы, сроки, доставка. Это прочитает ваш агент (Codex / Claude Code), оппонент не увидит.</p>
            <label>Мои условия сделки<textarea value={terms} required placeholder="Например: Покупаю ноутбук ThinkPad T480, готов заплатить до 30000 руб., самовывоз в выходные. Ниже 25000 было бы идеально." onChange={(e) => setTerms(e.target.value)} /></label>
            <button className="primary-button" type="submit" style={{ marginTop: 16 }}>Сохранить условия</button>
          </form>
        ) : (
          <>
            <p className="panel-help">Ваши условия: «{view.ownConditions!.text}»{view.ownConditions!.walkAwayPrice !== undefined ? ` · числовой предел: ${view.ownConditions!.walkAwayPrice}` : ''}</p>
            {inviteUrl && (
              <>
                <p className="section-kicker" style={{ marginTop: 18 }}>ОППОНЕНТ</p>
                <div className="link-grid">
                  <CopyField label="Опоненту" value={inviteUrl} copyKey="invite" href={inviteUrl} />
                </div>
                <p className="panel-help">Отправь эту ссылку оппоненту — он введёт свои условия и получит ссылку для своего агента.</p>
              </>
            )}
            <p className="section-kicker" style={{ marginTop: 18 }}>МОЙ АГЕНТ</p>
            <div className="link-grid">
              <CopyField label="Агенту" value={briefUrl} copyKey="agent" href={briefUrl} />
              <CopyField label="Страница" value={agentUrl} copyKey="agentpage" href={agentUrl} />
              <CopyField label="CLI" value={agentCli} copyKey="cli" />
            </div>
            <p className="panel-help">Бриф-ссылку отправь Codex / Claude Code — он начнёт торговаться сам. CLI — для терминала.</p>
            <form onSubmit={sendWhisper} style={{ marginTop: 18 }}>
              <p className="section-kicker">ШЁПОТ АГЕНТУ · ПРЯМО ПО ХОДУ ТОРГА</p>
              <label>Подсказка (например: «поднимись до 1750»)<input value={whisper} placeholder="Что передать своему агенту?" onChange={(e) => setWhisper(e.target.value)} /></label>
              <button className="secondary-button" type="submit" style={{ marginTop: 10 }}>Шепнуть агенту</button>
            </form>
            <p className="panel-help">Числа из шёпота расширяют лимит твоего агента наружу, текст он тоже прочитает. Оппонент не увидит.</p>
            <div className="readiness">
              <span className={view.agentOnline[view.role] ? 'ready' : ''}>Мой агент {view.agentOnline[view.role] ? 'в комнате' : 'не запущен'}</span>
              <span className={view.otherSubmitted ? 'ready' : ''}>Опонент {view.otherSubmitted ? 'ввёл условия' : 'ещё не ввёл'}</span>
            </div>
          </>
        )}
        {error && <div className="notice" style={{ marginTop: 12 }}>{error}</div>}
      </section>

      <section className="negotiation-panel room-window">
        <div className="panel-heading">
          <div>
            <p className="section-kicker">LIVE-ЛЕНТА · ОБЩАЯ ДЛЯ ОБОИХ</p>
            <h2>Переговоры</h2>
          </div>
          <span className="round-count">{STATUS_LABEL[view.status]} · {view.rounds}/{view.maxRounds}</span>
        </div>
        <ResultBanner result={view.result} />
        <Transcript messages={view.messages} />
      </section>
    </>
  );
}

// --- Экран 3: инвайт оппонента ---
function InviteView({ roomId, invite }: { roomId: string; invite: string }) {
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/claim`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ invite, origin: window.location.origin }),
        });
        const payload = await res.json();
        if (!res.ok) {
          if (alive) setError(payload.error ?? 'Инвайт недействителен.');
          return;
        }
        window.location.hash = `r=${roomId}&owner=${payload.ownerToken}`;
      } catch {
        if (alive) setError('Нет связи с сервером.');
      }
    })();
    return () => { alive = false; };
  }, [roomId, invite]);

  return (
    <section className="welcome-panel">
      <p className="section-kicker">ИНВАЙТ</p>
      {error ? <><h2>Не получилось войти</h2><p>{error}</p></> : <><h2>Принимаем инвайт...</h2><p>Секунду, готовим вашу сторону B.</p></>}
    </section>
  );
}

// --- Экран 4: страница для агента. Главную ссылку (/a/...) человек отправляет Codex / Claude Code ---
function AgentView({ roomId, side, token }: { roomId: string; side: Side; token: string }) {
  const { snapshot } = usePublicRoom(roomId);
  const origin = window.location.origin;
  const cli = buildAgentCli(wsOrigin(), roomId, side, token);
  const briefUrl = `${origin}/a/${encodeURIComponent(roomId)}/${side}/${encodeURIComponent(token)}`;
  const stateCurl = `curl "${origin}/api/rooms/${encodeURIComponent(roomId)}/agent-state?role=${side}&token=${encodeURIComponent(token)}"`;
  const [brief, setBrief] = useState('Загружаем бриф с сервера...');
  const [, copied] = useCopy();

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(briefUrl);
        if (alive) setBrief(await res.text());
      } catch {
        if (alive) setBrief('Не удалось загрузить бриф. Проверьте связь с сервером.');
      }
    })();
    return () => { alive = false; };
  }, [briefUrl]);

  return (
    <>
      <section className="agent-task">
        <div className="agent-task-heading">
          <p className="section-kicker">AUTONOMOUS AGENT TASK</p>
          <span className="role-badge">{side}</span>
        </div>
        <h2>Инструкции агенту {side} · {side === 'SIDE_A' ? 'Покупатель' : 'Продавец'}</h2>
        <ol>
          <li>Отправь своему агенту (Codex, Claude Code) <strong>ссылку-бриф ниже</strong> — он прочитает её сам через curl и начнёт торговаться.</li>
          <li>Или запусти детерминированный CLI из терминала (нужны числовые лимиты в условиях).</li>
          <li>Условия уже введены человеком — агент прочитает их с сервера сам.</li>
          <li>Финал смотри в общей ленте: ACCEPT или REJECT.</li>
        </ol>
        <div className="link-grid" style={{ marginTop: 12 }}>
          <CopyField label="Агенту (бриф-ссылка)" value={briefUrl} copyKey="brieflink" href={briefUrl} />
          <CopyField label="State" value={stateCurl} copyKey="state" />
          <CopyField label="CLI" value={cli} copyKey="cli" />
        </div>
        <pre className="agent-machine-instructions" style={{ position: 'static', width: 'auto', height: 'auto', clip: 'auto', overflow: 'auto', maxHeight: 320, whiteSpace: 'pre-wrap', marginTop: 12 }}>{brief}</pre>
        {copied && <p className="panel-help">Скопировано: {copied}</p>}
      </section>
      <section className="negotiation-panel room-window">
        <div className="panel-heading">
          <div><p className="section-kicker">СТАТУС КОМНАТЫ</p><h2>{snapshot ? STATUS_LABEL[snapshot.status] : 'Подключаемся...'}</h2></div>
          {snapshot && <span className="round-count">{snapshot.rounds}/{snapshot.maxRounds}</span>}
        </div>
        {snapshot && <><ResultBanner result={snapshot.result} /><Transcript messages={snapshot.messages} /></>}
      </section>
    </>
  );
}

// --- Экран 5: наблюдатель ---
function ObserverView({ roomId }: { roomId: string }) {
  const { snapshot, error } = usePublicRoom(roomId);
  return (
    <section className="negotiation-panel room-window">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">LIVE-ЛЕНТА · ТОЛЬКО ЧТЕНИЕ</p>
          <h2>Переговоры · {roomId.slice(0, 8)}</h2>
        </div>
        <span className="round-count">{snapshot ? `${STATUS_LABEL[snapshot.status]} · ${snapshot.rounds}/${snapshot.maxRounds}` : 'подключаемся...'}</span>
      </div>
      {error && <div className="notice">{error}</div>}
      {snapshot && (
        <>
          <div className="readiness">
            <span className={snapshot.submitted.SIDE_A ? 'ready' : ''}>A {snapshot.submitted.SIDE_A ? 'ввёл условия' : 'ждём'}</span>
            <span className={snapshot.submitted.SIDE_B ? 'ready' : ''}>B {snapshot.submitted.SIDE_B ? 'ввёл условия' : 'ждём'}</span>
            <span className={snapshot.agentOnline.SIDE_A ? 'ready' : ''}>Агент A {snapshot.agentOnline.SIDE_A ? 'online' : 'offline'}</span>
            <span className={snapshot.agentOnline.SIDE_B ? 'ready' : ''}>Агент B {snapshot.agentOnline.SIDE_B ? 'online' : 'offline'}</span>
          </div>
          <ResultBanner result={snapshot.result} />
          <Transcript messages={snapshot.messages} />
        </>
      )}
    </section>
  );
}

function App() {
  const route = useHashRoute();
  return (
    <main className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">AGENT DEALS ARENA</p>
          <h1>Люди договариваются. Агенты торгуются.</h1>
          <p className="hero-copy">Каждый человек вводит свои условия в вебе и отправляет ссылку своему агенту. Агенты торгуются в терминале, оба человека наблюдают здесь.</p>
        </div>
      </header>

      <section className="rules-strip" aria-labelledby="rules-title">
        <div><p className="section-kicker">ОБЩИЕ ПРАВИЛА ОБОИХ АГЕНТОВ</p><h2 id="rules-title">Инструкции агентов</h2></div>
        <ul>{ConductRules.map((rule) => <li key={rule}>{rule}</li>)}</ul>
      </section>

      {route.view === 'home' && <HomeView />}
      {route.view === 'owner' && <OwnerView roomId={route.roomId} owner={route.owner} />}
      {route.view === 'invite' && <InviteView roomId={route.roomId} invite={route.invite} />}
      {route.view === 'agent' && <AgentView roomId={route.roomId} side={route.side} token={route.token} />}
      {route.view === 'observer' && <ObserverView roomId={route.roomId} />}
    </main>
  );
}

export default App;
