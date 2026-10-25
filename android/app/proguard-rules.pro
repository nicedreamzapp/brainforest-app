# Keep the JS bridge entry points reachable from the WebView.
-keepclassmembers class com.brainforest.app.MainActivity$Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
