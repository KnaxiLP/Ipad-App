// ================= Python-Ausführung (läuft im Hintergrund-Worker) =================
// Python kommt von Pyodide (Python für den Browser). Beim ersten Start werden ca. 10 MB
// geladen, danach liegt alles im Speicher des iPads und geht auch offline.
//
// input(): Ein Worker kann nicht auf eine Eingabe "warten". Deshalb bricht das Programm
// bei input() ab, die App fragt nach der Antwort und startet das Programm neu – diesmal
// mit der Antwort. Bis zu dieser Stelle wird alles stumm "vorgespult" (gleicher
// Zufalls-Seed, sleep() wird übersprungen), sodass es sich wie ein normales Programm anfühlt.
const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';
importScripts(PYODIDE_URL + 'pyodide.js');

const state = { replaying: false };

function makeStream(type) {
  let bytes = [];
  const decoder = new TextDecoder();
  return {
    raw(c) {
      bytes.push(c);
      if (c === 10 || bytes.length > 2048) this.flush();
    },
    flush() {
      if (!bytes.length) return;
      const text = decoder.decode(new Uint8Array(bytes));
      bytes = [];
      if (!state.replaying) postMessage({ type, text });
    }
  };
}
const out = makeStream('out');
const err = makeStream('err');
const flushAll = () => { out.flush(); err.flush(); };

// Wird aus Python aufgerufen
const bridge = {
  live() { flushAll(); state.replaying = false; },
  pause() { flushAll(); state.replaying = true; },
  isReplaying() { return state.replaying; },
  image(b64) { flushAll(); if (!state.replaying) postMessage({ type: 'image', data: b64 }); }
};

const SETUP = `
import sys, builtins, time, random, traceback, linecache, json, os
import _bridge

os.environ['MPLBACKEND'] = 'agg'

class _NeedInput(BaseException):
    pass

_state = {'inputs': [], 'pos': 0, 'need': None}
_real_sleep = time.sleep

def _input(prompt=''):
    st = _state
    if st['need'] is not None:
        raise _NeedInput(st['need'])
    if st['pos'] < len(st['inputs']):
        value = st['inputs'][st['pos']]
        st['pos'] += 1
        if st['pos'] == len(st['inputs']):
            sys.stdout.flush()
            sys.stderr.flush()
            _bridge.live()
        return value
    sys.stdout.flush()
    sys.stderr.flush()
    st['need'] = str(prompt)
    _bridge.pause()
    raise _NeedInput(st['need'])

def _sleep(seconds):
    if _bridge.isReplaying():
        return
    sys.stdout.flush()
    _real_sleep(seconds)

builtins.input = _input
time.sleep = _sleep

_plt = None

def _show(*args, **kwargs):
    import io, base64
    if _plt is None:
        return
    for num in _plt.get_fignums():
        fig = _plt.figure(num)
        buf = io.BytesIO()
        fig.savefig(buf, format='png', dpi=110, bbox_inches='tight')
        sys.stdout.flush()
        _bridge.image(base64.b64encode(buf.getvalue()).decode())
    _plt.close('all')

def _patch_matplotlib():
    global _plt
    if _plt is not None:
        return
    try:
        import matplotlib
        matplotlib.use('agg')
        import matplotlib.pyplot as plt
    except Exception:
        return
    plt.show = _show
    _plt = plt

def _run(code, inputs_json, seed):
    _state['inputs'] = json.loads(inputs_json)
    _state['pos'] = 0
    _state['need'] = None
    random.seed(seed)
    filename = '<main.py>'
    linecache.cache[filename] = (len(code), None, code.splitlines(True), filename)
    g = {'__name__': '__main__', '__builtins__': builtins}
    try:
        if 'matplotlib' in code:
            _patch_matplotlib()
        exec(compile(code, filename, 'exec'), g)
        if _plt is not None and _plt.get_fignums():
            _show()
        result = {'status': 'ok'}
    except _NeedInput:
        result = {'status': 'ok'}
    except SystemExit:
        result = {'status': 'ok'}
    except BaseException as e:
        tb = [f for f in traceback.extract_tb(e.__traceback__) if f.filename == filename]
        text = ''
        if tb:
            text = 'Traceback (most recent call last):\\n' + ''.join(traceback.format_list(tb))
        text += ''.join(traceback.format_exception_only(type(e), e))
        line = tb[-1].lineno if tb else getattr(e, 'lineno', None)
        result = {'status': 'error', 'error': text, 'line': line}
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
    # Auch wenn das Programm den Abbruch mit "except:" abgefangen hat: Eingabe nachholen
    if _state['need'] is not None:
        result = {'status': 'input', 'prompt': _state['need']}
    return json.dumps(result)
`;

let py = null;

const ready = (async () => {
  try {
    py = await loadPyodide({ indexURL: PYODIDE_URL });
    py.setStdout({ raw: (c) => out.raw(c) });
    py.setStderr({ raw: (c) => err.raw(c) });
    py.registerJsModule('_bridge', bridge);
    py.runPython(SETUP);
    postMessage({ type: 'ready', version: py.version });
  } catch (e) {
    postMessage({ type: 'fatal', error: String(e && e.message || e) });
  }
})();

onmessage = async (e) => {
  const msg = e.data;
  if (msg.type !== 'run') return;
  await ready;
  if (!py) return;

  try {
    await py.loadPackagesFromImports(msg.code, {
      messageCallback: (m) => postMessage({ type: 'status', text: m }),
      errorCallback: () => {}
    });
  } catch {
    // Fehlt ein Paket, meldet Python das gleich selbst mit einem ImportError
  }

  state.replaying = msg.inputs.length > 0;
  let result;
  try {
    result = JSON.parse(py.globals.get('_run')(msg.code, JSON.stringify(msg.inputs), msg.seed));
  } catch (e) {
    result = { status: 'error', error: String(e && e.message || e) };
  }
  state.replaying = false;
  flushAll();
  postMessage({ type: 'done', result });
};
