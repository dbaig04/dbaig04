import json,glob,sys,base64
B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
def b58d(s):
    n=0
    for c in s: n=n*58+B58.index(c)
    b=n.to_bytes((n.bit_length()+7)//8,'big'); pad=len(s)-len(s.lstrip('1')); return b'\0'*pad+b
def show(f):
    t=json.load(open(f))['result']; m=t['transaction']['message']; la=t['meta'].get('loadedAddresses',{})
    keys=m['accountKeys']+la.get('writable',[])+la.get('readonly',[])
    h=m['header']; nk=len(m['accountKeys'])
    def w(i):
        if i<nk:
            s=i<h['numRequiredSignatures']
            return ('S' if s else '-')+('W' if (i<h['numRequiredSignatures']-h['numReadonlySignedAccounts'] if s else i<nk-h['numReadonlyUnsignedAccounts']) else 'r')
        return '-W' if i<nk+len(la.get('writable',[])) else '-r'
    print('==',f,'fee',t['meta']['fee'],'cu',t['meta'].get('computeUnitsConsumed'),'err',t['meta']['err'],'ver',t.get('version'),'luts',[a['accountKey'] for a in m.get('addressTableLookups',[])])
    for n,ix in enumerate(m['instructions']):
        d=b58d(ix['data']); print(f' ix{n}',keys[ix['programIdIndex']],'data',d.hex())
        for j,a in enumerate(ix['accounts']): print(f'   {j:2} {w(a)} {keys[a]}')
    for g in t['meta']['innerInstructions']:
        for ix in g['instructions']:
            d=b58d(ix['data']); print(f'  inner of ix{g["index"]}',keys[ix['programIdIndex']],d.hex()[:80],[keys[a][:6] for a in ix['accounts']])
    for l in t['meta']['logMessages']: print('  LOG',l[:200])
    pre={(b['accountIndex']):b for b in t['meta']['preTokenBalances']}
    for b in t['meta']['postTokenBalances']:
        p=pre.get(b['accountIndex']); print('  TOK',keys[b['accountIndex']][:8],b['mint'][:8],b['owner'][:8],p['uiTokenAmount']['amount'] if p else None,'->',b['uiTokenAmount']['amount'])
    print('  SOL',[ (keys[i][:8],a,b) for i,(a,b) in enumerate(zip(t['meta']['preBalances'],t['meta']['postBalances'])) if a!=b])
for f in sys.argv[1:]: show(f)
