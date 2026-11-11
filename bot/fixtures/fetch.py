import json,urllib.request,time,os,sys
R="https://api.mainnet-beta.solana.com"
def rpc(m,p):
    for i in range(6):
        try:
            req=urllib.request.Request(R,json.dumps({"jsonrpc":"2.0","id":1,"method":m,"params":p}).encode(),{"content-type":"application/json"})
            r=json.load(urllib.request.urlopen(req,timeout=30))
            if 'error' in r and r['error'].get('code')==429: raise Exception('429')
            return r
        except Exception as e: time.sleep(2**i)
sigs=json.load(open('sigs.json'))['result']
for s in sigs:
    f=f"tx/{s['signature']}.json"
    if os.path.exists(f): continue
    r=rpc("getTransaction",[s['signature'],{"encoding":"json","maxSupportedTransactionVersion":0}])
    json.dump(r,open(f,'w')); time.sleep(0.3)
