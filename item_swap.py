import json, time, pathlib, urllib.request, urllib.error, sys
import jwt
KEY_ID="VSXKZZ79TK"; ISSUER="1ab8acba-26d0-4a22-b2e4-96398ed7ade5"
P8=pathlib.Path.home()/".appstoreconnect/private_keys/AuthKey_VSXKZZ79TK.p8"
SID="1a2e968c-9d52-4d2d-9dd3-1dee840177e3"
VER="ad7086ad-1f60-454b-9915-ee0584ce79c9"
def tok():
    now=int(time.time())
    return jwt.encode({"iss":ISSUER,"iat":now,"exp":now+1200,"aud":"appstoreconnect-v1"},P8.read_text(),algorithm="ES256",headers={"kid":KEY_ID,"typ":"JWT"})
def call(path, method="GET", body=None):
    r=urllib.request.Request("https://api.appstoreconnect.apple.com"+path,method=method,headers={"Authorization":"Bearer "+tok()})
    if body is not None:
        r.add_header("Content-Type","application/json"); r.data=json.dumps(body).encode()
    try:
        raw=urllib.request.urlopen(r).read().decode()
        return 200, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode())
        except Exception: return e.code, {}
st, items = call(f"/v1/reviewSubmissions/{SID}/items")
for it in items["data"]:
    if it["attributes"]["state"] == "REJECTED":
        st2, out = call("/v1/reviewSubmissionItems/" + it["id"], "DELETE")
        print("delete rejected item ->", st2, flush=True)
st, out = call("/v1/reviewSubmissionItems", "POST", {"data":{
    "type":"reviewSubmissionItems",
    "relationships":{
        "reviewSubmission":{"data":{"type":"reviewSubmissions","id":SID}},
        "appStoreVersion":{"data":{"type":"appStoreVersions","id":VER}}}}})
print("add fresh item ->", st, json.dumps(out)[:300] if st>=400 else out["data"]["attributes"], flush=True)
for attempt in range(4):
    st, out = call(f"/v1/reviewSubmissions/{SID}", "PATCH", {"data":{
        "type":"reviewSubmissions","id":SID,"attributes":{"submitted":True}}})
    if st < 400:
        print("RESUBMITTED:", out["data"]["attributes"]); sys.exit(0)
    det=[e.get("detail","") for e in out.get("errors",[])]
    assoc=[x.get("detail","") for e in out.get("errors",[]) for a in (e.get("meta",{}) or {}).get("associatedErrors",{}).values() for x in a]
    print(f"submit attempt {attempt+1}: {st} {det} {assoc}", flush=True)
    time.sleep(45)
sys.exit(1)
