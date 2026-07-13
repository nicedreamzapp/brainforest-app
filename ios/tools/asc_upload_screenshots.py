#!/usr/bin/env python3
"""Upload App Store screenshots via the ASC public API.
Hand-rolled ES256 JWT (no PyJWT dependency). Idempotent-ish: deletes existing
screenshots in each target set before uploading the new ones in order."""
import base64, hashlib, json, os, sys, time, urllib.request

KEY_ID = os.environ["ASC_KEY_ID"]
ISSUER = os.environ["ASC_ISSUER_ID"]
P8 = os.path.expanduser(f"~/.appstoreconnect/private_keys/AuthKey_{KEY_ID}.p8")
API = "https://api.appstoreconnect.apple.com"
VERSION_ID = "4b43e937-9473-46ef-ba91-68a57ec5aeb1"

SETS = [
    ("APP_IPHONE_67", os.path.expanduser("~/Documents/Brainforest/appstore/screenshots/iphone")),
    ("APP_IPAD_PRO_3GEN_129", os.path.expanduser("~/Documents/Brainforest/appstore/screenshots/ipad")),
]

def b64u(b): return base64.urlsafe_b64encode(b).rstrip(b"=")

def jwt_token():
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec, utils
    key = serialization.load_pem_private_key(open(P8, "rb").read(), password=None)
    now = int(time.time())
    header = b64u(json.dumps({"alg": "ES256", "kid": KEY_ID, "typ": "JWT"}).encode())
    payload = b64u(json.dumps({"iss": ISSUER, "iat": now, "exp": now + 900,
                               "aud": "appstoreconnect-v1"}).encode())
    signing = header + b"." + payload
    der = key.sign(signing, ec.ECDSA(hashes.SHA256()))
    r, s = utils.decode_dss_signature(der)
    sig = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    return (signing + b"." + b64u(sig)).decode()

TOKEN = jwt_token()

def req_retry(method, url, body=None, headers=None, raw=False):
    global TOKEN
    st, j = req(method, url, body, headers, raw)
    if st == 401 and not raw:
        TOKEN = jwt_token()          # clock skew / token hiccup: mint fresh, retry once
        st, j = req(method, url, body, headers, raw)
    return st, j

def req(method, url, body=None, headers=None, raw=False):
    # raw uploads go to Apple's storage CDN: ONLY the operation's own headers,
    # never the ASC bearer token (it breaks the pre-signed request)
    h = {} if raw else {"Authorization": f"Bearer {TOKEN}"}
    if body is not None and not raw:
        h["Content-Type"] = "application/json"
        body = json.dumps(body).encode()
    h.update(headers or {})
    r = urllib.request.Request(url if url.startswith("http") else API + url,
                               data=body, headers=h, method=method)
    try:
        with urllib.request.urlopen(r) as resp:
            data = resp.read()
            return resp.status, json.loads(data) if (data.strip() and not raw) else {}
    except urllib.error.HTTPError as e:
        errbody = e.read() or b""
        try:
            return e.code, json.loads(errbody)
        except Exception:
            return e.code, {"raw_error": errbody.decode(errors="replace")[:300]}

def main():
    # en-US localization for the version
    st, j = req_retry("GET", f"/v1/appStoreVersions/{VERSION_ID}/appStoreVersionLocalizations")
    assert st == 200, j
    loc = next((d["id"] for d in j["data"] if d["attributes"]["locale"] == "en-US"),
               j["data"][0]["id"])
    print("localization:", loc)

    for display_type, folder in SETS:
        st, j = req_retry("GET", f"/v1/appStoreVersionLocalizations/{loc}/appScreenshotSets?limit=50")
        assert st == 200, j
        match = [d for d in j["data"] if d["attributes"]["screenshotDisplayType"] == display_type]
        if match:
            set_id = match[0]["id"]
        else:
            st, j = req_retry("POST", "/v1/appScreenshotSets", {
                "data": {"type": "appScreenshotSets",
                         "attributes": {"screenshotDisplayType": display_type},
                         "relationships": {"appStoreVersionLocalization": {
                             "data": {"type": "appStoreVersionLocalizations", "id": loc}}}}})
            assert st == 201, j
            set_id = j["data"]["id"]
        print(display_type, "set:", set_id)

        # clear any existing shots so re-runs replace instead of append
        st, j = req_retry("GET", f"/v1/appScreenshotSets/{set_id}/appScreenshots?limit=50")
        for d in j.get("data", []):
            req_retry("DELETE", f"/v1/appScreenshots/{d['id']}")

        for name in sorted(os.listdir(folder)):
            if not name.endswith(".png"):
                continue
            path = os.path.join(folder, name)
            data = open(path, "rb").read()
            st, j = req_retry("POST", "/v1/appScreenshots", {
                "data": {"type": "appScreenshots",
                         "attributes": {"fileName": name, "fileSize": len(data)},
                         "relationships": {"appScreenshotSet": {
                             "data": {"type": "appScreenshotSets", "id": set_id}}}}})
            assert st == 201, (name, j)
            shot = j["data"]
            for op in shot["attributes"]["uploadOperations"]:
                chunk = data[op["offset"]:op["offset"] + op["length"]]
                hdrs = {h["name"]: h["value"] for h in op.get("requestHeaders", [])}
                st2, _ = req(op["method"], op["url"], body=chunk, headers=hdrs, raw=True)
                assert st2 in (200, 201), (name, st2)
            st, j = req_retry("PATCH", f"/v1/appScreenshots/{shot['id']}", {
                "data": {"type": "appScreenshots", "id": shot["id"],
                         "attributes": {"uploaded": True,
                                        "sourceFileChecksum": hashlib.md5(data).hexdigest()}}})
            assert st == 200, (name, j)
            print("  uploaded", name)

if __name__ == "__main__":
    main()
