import json, time, pathlib, urllib.request, urllib.error
import jwt
KEY_ID="VSXKZZ79TK"; ISSUER="1ab8acba-26d0-4a22-b2e4-96398ed7ade5"
P8=pathlib.Path.home()/".appstoreconnect/private_keys/AuthKey_VSXKZZ79TK.p8"
VER="ad7086ad-1f60-454b-9915-ee0584ce79c9"; APP="6788301765"
now=int(time.time())
tok=jwt.encode({"iss":ISSUER,"iat":now,"exp":now+1200,"aud":"appstoreconnect-v1"},P8.read_text(),algorithm="ES256",headers={"kid":KEY_ID,"typ":"JWT"})
def call(path):
    r=urllib.request.Request("https://api.appstoreconnect.apple.com"+path,headers={"Authorization":"Bearer "+tok})
    try: return json.loads(urllib.request.urlopen(r).read())
    except urllib.error.HTTPError as e: return {"ERR": e.code, "body": e.read().decode()[:200]}
v=call(f"/v1/appStoreVersions/{VER}")
print("version attrs:", json.dumps(v["data"]["attributes"]))
b=call(f"/v1/appStoreVersions/{VER}/build")
print("attached build:", b["data"]["id"] if b.get("data") else None, json.dumps(b["data"]["attributes"]) if b.get("data") else "")
for rel in ["appStoreVersionSubmission","appStoreVersionPhasedRelease","appStoreReviewDetail"]:
    r=call(f"/v1/appStoreVersions/{VER}/{rel}")
    d=r.get("data")
    print(rel+":", json.dumps(d["attributes"]) if d else d if "ERR" not in r else r)
subs=call(f"/v1/apps/{APP}/reviewSubmissions?limit=10")
for s in subs["data"]:
    print("sub:", s["id"][:8], s["attributes"]["state"])
