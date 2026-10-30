// MB Soundtools · MBMix para Android
// La interfaz y el motor (modelos de mesa, OSC, demo, escenas…) son los mismos archivos web de MBMix.
// Esta parte nativa solo aporta lo que un navegador no puede hacer: hablar con la mesa por UDP,
// buscar mesas en la red, guardar datos en el teléfono y mantener la pantalla encendida.
package com.mbsoundtools.mbmix;

import android.app.Activity;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.util.Collections;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private WebView web;
    private DatagramSocket socket;
    private SharedPreferences prefs;
    private final ExecutorService net = Executors.newSingleThreadExecutor();

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN);
        if (Build.VERSION.SDK_INT >= 28) {
            getWindow().getAttributes().layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        prefs = getSharedPreferences("mbmix", MODE_PRIVATE);

        web = new WebView(this);
        web.setBackgroundColor(0xFF050505);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100);
        web.addJavascriptInterface(new Bridge(), "MBAndroid");
        web.setWebViewClient(new WebViewClient());
        setContentView(web);

        try {
            socket = new DatagramSocket();
            socket.setBroadcast(true);
            new Thread(this::readLoop, "mbmix-udp").start();
        } catch (Exception e) {
            socket = null;
        }
        web.loadUrl("file:///android_asset/web/index.html");
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) immersive();
    }

    private void immersive() {
        web.setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }

    @Override
    public void onBackPressed() {
        // atrás: cierra la ventana o el canal abierto; si no hay nada abierto, sale de la app
        web.evaluateJavascript("(window.MBBack&&MBBack())?'1':'0'", r -> {
            if (!"\"1\"".equals(r)) MainActivity.super.onBackPressed();
        });
    }

    @Override
    protected void onDestroy() {
        if (socket != null) socket.close();
        net.shutdownNow();
        super.onDestroy();
    }

    // ---------------------------------------------------------------- UDP
    private void readLoop() {
        byte[] buf = new byte[65536];
        while (socket != null && !socket.isClosed()) {
            try {
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                socket.receive(p);
                String ip = p.getAddress().getHostAddress();
                int port = p.getPort();
                String b64 = Base64.encodeToString(p.getData(), p.getOffset(), p.getLength(), Base64.NO_WRAP);
                String js = "MBNative.recv('" + ip + "'," + port + ",'" + b64 + "')";
                runOnUiThread(() -> web.evaluateJavascript(js, null));
            } catch (Exception e) {
                try { Thread.sleep(20); } catch (InterruptedException ie) { return; }
            }
        }
    }

    private void send(byte[] data, String ip, int port) {
        try {
            if (socket != null) socket.send(new DatagramPacket(data, data.length, InetAddress.getByName(ip), port));
        } catch (Exception ignored) { }
    }

    /** Pregunta a todas las direcciones de la red del teléfono (y por difusión) si hay una WING o una X Air. */
    private void scan(byte[] wing, byte[] xair) {
        send(wing, "255.255.255.255", 2222);
        send(xair, "255.255.255.255", 10024);
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    if (!(ia.getAddress() instanceof Inet4Address)) continue;
                    byte[] a = ia.getAddress().getAddress();
                    int ip = ((a[0] & 255) << 24) | ((a[1] & 255) << 16) | ((a[2] & 255) << 8) | (a[3] & 255);
                    int prefix = Math.max(24, (int) ia.getNetworkPrefixLength());   // como mucho, la /24 del teléfono
                    int mask = prefix >= 32 ? -1 : ~((1 << (32 - prefix)) - 1);
                    int base = ip & mask, count = ~mask;
                    if (ia.getBroadcast() != null) {
                        send(wing, ia.getBroadcast().getHostAddress(), 2222);
                        send(xair, ia.getBroadcast().getHostAddress(), 10024);
                    }
                    for (int h = 1; h < count; h++) {
                        int t = base | h;
                        if (t == ip) continue;
                        String s = ((t >>> 24) & 255) + "." + ((t >>> 16) & 255) + "." + ((t >>> 8) & 255) + "." + (t & 255);
                        send(wing, s, 2222);
                        send(xair, s, 10024);
                        if (h % 32 == 0) Thread.sleep(5);
                    }
                }
            }
        } catch (Exception ignored) { }
    }

    // ---------------------------------------------------------------- puente con la página
    private class Bridge {
        @JavascriptInterface
        public void post(String json) {
            try {
                JSONObject o = new JSONObject(json);
                switch (o.optString("op")) {
                    case "send": {
                        byte[] d = Base64.decode(o.getString("data"), Base64.DEFAULT);
                        String ip = o.getString("ip");
                        int port = o.getInt("port");
                        net.execute(() -> send(d, ip, port));
                        break;
                    }
                    case "scan": {
                        byte[] w = Base64.decode(o.getString("wing"), Base64.DEFAULT);
                        byte[] x = Base64.decode(o.getString("xair"), Base64.DEFAULT);
                        new Thread(() -> scan(w, x), "mbmix-scan").start();
                        break;
                    }
                    case "save":
                        prefs.edit().putString(o.getString("key"), o.getString("value")).apply();
                        break;
                    case "awake": {
                        boolean on = o.optBoolean("on");
                        runOnUiThread(() -> {
                            if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                            else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                        });
                        break;
                    }
                    default:
                        break;
                }
            } catch (Exception ignored) { }
        }

        /** Datos guardados (mezclas, capas, preferencias) para la página. */
        @JavascriptInterface
        public String store() {
            JSONObject o = new JSONObject();
            try {
                for (Map.Entry<String, ?> e : prefs.getAll().entrySet()) o.put(e.getKey(), String.valueOf(e.getValue()));
            } catch (Exception ignored) { }
            return o.toString();
        }
    }
}
