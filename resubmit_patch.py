import json, time, pathlib, urllib.request, urllib.error, sys
import jwt
KEY_ID="VSXKZZ79TK"; ISSUER="1ab8acba-26d0-4a22-b2e4-96398ed7ade5"
P8=pathlib.Path.home()/".appstoreconnect/private_keys/AuthKey_VSXKZZ79TK.p8"
sid="1a2e968c-9d52-4d2d-9dd3-1dee840177e3"
def tok():
    now=int(time.time())
    return jwt.encode({"iss":ISSUER,"iat":now,"exp":now+1200,"aud":"appstoreconnect-v1"},P8.read_text(),algorithm="ES256",headers={"kid":KEY_ID,"typ":"JWT"})
for attempt in range(40):
    body=json.dumps({"data":{"type":"reviewSubmissions","id":sid,"attributes":{"submitted":True}}}).encode()
    r=urllib.request.Request(f"https://api.appstoreconnect.apple.com/v1/reviewSubmissions/{sid}",method="PATCH",data=body,headers={"Authorization":"Bearer "+tok(),"Content-Type":"application/json"})
    try:
        resp=json.loads(urllib.request.urlopen(r).read())
        print("SUCCESS:", resp["data"]["attributes"]); sys.exit(0)
    except urllib.error.HTTPError as e:
        detail=e.read().decode()
        try: detail="; ".join(x.get("detail",x.get("title","")) for x in json.loads(detail)["errors"])
        except Exception: detail=detail[:300]
        print(f"attempt {attempt+1}: HTTP {e.code}: {detail}", flush=True)
        if attempt < 39: time.sleep(60)
print("ALL RETRIES FAILED"); sys.exit(1)
