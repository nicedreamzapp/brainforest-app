import json, time, pathlib, urllib.request, urllib.error
import jwt
KEY_ID="VSXKZZ79TK"; ISSUER="1ab8acba-26d0-4a22-b2e4-96398ed7ade5"
P8=pathlib.Path.home()/".appstoreconnect/private_keys/AuthKey_VSXKZZ79TK.p8"
sid="1a2e968c-9d52-4d2d-9dd3-1dee840177e3"
now=int(time.time())
tok=jwt.encode({"iss":ISSUER,"iat":now,"exp":now+1200,"aud":"appstoreconnect-v1"},P8.read_text(),algorithm="ES256",headers={"kid":KEY_ID,"typ":"JWT"})
def call(path, method="GET", body=None):
    r=urllib.request.Request("https://api.appstoreconnect.apple.com"+path,method=method,headers={"Authorization":"Bearer "+tok})
    if body is not None:
        r.add_header("Content-Type","application/json"); r.data=json.dumps(body).encode()
    try:
        return json.loads(urllib.request.urlopen(r).read())
    except urllib.error.HTTPError as e:
        return {"HTTPERROR": e.code, "body": json.loads(e.read().decode())}
s=call(f"/v1/reviewSubmissions/{sid}?include=items")
print("submission:", json.dumps(s["data"]["attributes"]))
items=call(f"/v1/reviewSubmissions/{sid}/items")
for it in items["data"]:
    print("item:", it["id"], json.dumps(it["attributes"]))
# full error body on PATCH
p=call(f"/v1/reviewSubmissions/{sid}","PATCH",{"data":{"type":"reviewSubmissions","id":sid,"attributes":{"submitted":True}}})
print("patch:", json.dumps(p)[:1500])
