/** AKK-side macOS peer credential bridge. Never installed into or registered as Claude. */
export const CLAUDE_NATIVE_PEER_HELPER = String.raw`
import sys,os,json,socket,struct,stat,subprocess,time,select,uuid,signal
listeners={}
def stop(signum,frame):raise SystemExit(0)
signal.signal(signal.SIGTERM,stop)
def emit(value):
 print(json.dumps(value,separators=(',',':')),flush=True)
def owned(p,kind):
 s=os.lstat(p)
 valid=stat.S_ISREG(s.st_mode) if kind=='file' else stat.S_ISSOCK(s.st_mode) if kind=='socket' else stat.S_ISDIR(s.st_mode)
 if s.st_uid!=os.getuid() or s.st_mode & 0o022 or not valid: raise ValueError('unsafe_metadata')
 return s
def validate(e,idle=False):
 p=os.path.join(e['configDir'],'sessions',str(e['pid'])+'.json')
 owned(e['configDir'],'directory');owned(os.path.dirname(p),'directory')
 if owned(p,'file').st_size>65536: raise ValueError('invalid_registry')
 with open(p) as f:m=json.load(f)
 start=' '.join(str(m.get('procStart','')).split())
 if m.get('pid')!=e['pid'] or m.get('sessionId')!=e['sessionId'] or start!=e['processStart']:raise ValueError('identity_changed')
 if m.get('messagingSocketPath')!=e['socketPath'] or m.get('peerProtocol')!=1:raise ValueError('unsupported_contract')
 value=subprocess.check_output(['/bin/ps','-p',str(e['pid']),'-o','uid=','-o','lstart='],timeout=2,text=True,env={**os.environ,'LC_ALL':'C','TZ':'UTC'})
 if ' '.join(value.split())!=str(os.getuid())+' '+e['processStart']:raise ValueError('process_changed')
 if idle and m.get('status')!='idle':raise ValueError('session_not_idle')
 owned(os.path.realpath(os.path.dirname(e['socketPath'])),'directory');owned(e['socketPath'],'socket')
def peer(c,pid):
 actual=struct.unpack('i',c.getsockopt(0,2,4))[0]
 cred=c.getsockopt(0,1,80)
 version,uid=struct.unpack_from('II',cred)
 if actual!=pid or version!=0 or uid!=os.getuid():raise ValueError('peer_identity_mismatch')
def reply(e):
 key=e['socketPath']+'|'+e['sessionId']+'|'+e['processStart']
 if key in listeners:return listeners[key]
 # A small fixed bound prevents a long-lived host from leaking sockets indefinitely.
 if len(listeners)>=32:raise ValueError('listener_limit')
 p=os.path.join(os.path.dirname(e['socketPath']),str(os.getpid())+'-'+uuid.uuid4().hex[:8]+'.sock')
 s=socket.socket(socket.AF_UNIX);created=False
 try:
  s.bind(p);created=True;os.chmod(p,0o600);s.listen(8);s.setblocking(False)
 except BaseException:
  s.close()
  if created:
   try:os.unlink(p)
   except OSError:pass
  raise
 value=(s,p,e);listeners[key]=value;return value
def receive(ready):
 messages=[]
 for listener in ready:
  entry=next((v for v in listeners.values() if v[0]==listener),None)
  if not entry:continue
  c=None
  try:
   c,_=listener.accept();c.settimeout(.2);peer(c,entry[2]['pid']);validate(entry[2]);buf=b''
   while len(buf)<=65536:
    part=c.recv(8192)
    if not part:break
    buf+=part
    if b'\n' in buf:break
   for line in buf.splitlines():
    m=json.loads(line)
    if m.get('type')!='control' or m.get('action') not in ['peer_message_status','peer_idle_notice']:continue
    if not isinstance(m.get('orig_msg_id'),str):continue
    # Do not relay arbitrary native detail, transcript content or prompt material.
    clean={k:m[k] for k in ['action','orig_msg_id','status','status_detail','state','finished_at'] if k in m and isinstance(m[k],(str,int,float,bool))}
    messages.append(clean);emit({'event':'notice','sessionId':entry[2]['sessionId'],'pid':entry[2]['pid'],'notice':clean})
  except Exception:pass
  finally:
   if c:c.close()
 return messages
def operation(q):
 e=q['entry'];validate(e,q['action']=='send');c=socket.socket(socket.AF_UNIX);c.settimeout(2);written=False
 try:
  c.connect(e['socketPath']);peer(c,e['pid']);validate(e,q['action']=='send')
  if q['action']=='probe':return {'dispatchState':'not_sent','peerPid':e['pid']}
  ls,p,_=reply(e)
  frame={'type':'user','session_id':e['sessionId'],'uuid':q['inputUuid'],'msgV':1,'msg_id':q['messageId'],'priority':'next','from':'uds:'+p,'message':{'role':'user','content':q['text']}}
  data=(json.dumps(frame,separators=(',',':'))+'\n').encode()
  # Persist-before-dispatch is performed in the parent; any sendall failure is uncertain.
  written=True;c.sendall(data)
  until=time.monotonic()+.4;messages=[]
  while time.monotonic()<until:
   ready,_,_=select.select([x[0] for x in listeners.values()],[],[],max(0,until-time.monotonic()))
   messages+=receive(ready)
  result={'dispatchState':'written'}
  for m in messages:
   if m.get('orig_msg_id')==q['messageId']:
    status='refused' if m.get('status_detail')=='refused' else m.get('status')
    if status in ['held','delivered','refused','expired']:result['deliveryStatus']=status
  return result
 except Exception as exc:
  code=str(exc) if isinstance(exc,ValueError) else 'peer_transport_error'
  return {'dispatchState':'uncertain' if written else 'not_sent','errorCode':code}
 finally:c.close()
try:
 emit({'ready':True,'pid':os.getpid()})
 incoming=b''
 while True:
  ready,_,_=select.select([sys.stdin]+[x[0] for x in listeners.values()],[],[],1)
  receive([x for x in ready if x is not sys.stdin])
  if sys.stdin not in ready:continue
  part=os.read(sys.stdin.fileno(),65536)
  if not part:break
  incoming+=part
  if len(incoming)>2097152:break
  while b'\n' in incoming:
   line,incoming=incoming.split(b'\n',1);q={}
   try:
    q=json.loads(line)
    if q.get('action')=='close':raise SystemExit(0)
    if q.get('action') not in ['probe','send']:raise ValueError('invalid_action')
    emit({'id':q['id'],'result':operation(q)})
   except Exception as exc:emit({'id':q.get('id'),'result':{'dispatchState':'not_sent','errorCode':str(exc) if isinstance(exc,ValueError) else 'peer_transport_error'}})
finally:
 for s,p,_ in listeners.values():
  s.close()
  try:
   if stat.S_ISSOCK(os.lstat(p).st_mode) and os.lstat(p).st_uid==os.getuid():os.unlink(p)
  except OSError:pass
`;
