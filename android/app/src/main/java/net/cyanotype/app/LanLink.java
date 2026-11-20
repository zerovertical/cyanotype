package net.cyanotype.app;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;

import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Reader;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/* Finding other Cyanotype phones on the same Wi-Fi, and passing lines of text
   between them.

   This class is deliberately dumb. It announces "a Cyanotype phone is here"
   under a random name that changes every time the app starts, lists the other
   phones announcing the same thing, and opens plain sockets so the page can
   talk to them. It never looks inside a line: deciding whether the other end is
   a contact, checking its proofs and opening the sealed offer all happen in the
   page. Anything arriving here may come from a stranger on the network, so the
   only rules enforced are size and count limits. */
final class LanLink {

    interface Events {
        void peer(String peer, boolean found);
        void frame(String conn, String data);
        void closed(String conn);
    }

    static final String TYPE = "_cyanotype._tcp.";
    static final int MAX_LINE = 32 * 1024;
    static final int MAX_CONNS = 16;
    static final int IDLE_MS = 60_000;
    static final int CONNECT_MS = 5_000;

    private final Context ctx;
    private final Events events;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Map<String, NsdServiceInfo> peers = new ConcurrentHashMap<>();
    private final Map<String, Conn> conns = new ConcurrentHashMap<>();
    private final ArrayDeque<NsdServiceInfo> toResolve = new ArrayDeque<>();
    private boolean resolving = false;

    private NsdManager nsd;
    private WifiManager.MulticastLock multicast;
    private ServerSocket server;
    private NsdManager.RegistrationListener registration;
    private NsdManager.DiscoveryListener discovery;
    private volatile String myName;
    private volatile boolean running = false;

    LanLink(Context ctx, Events events) {
        this.ctx = ctx.getApplicationContext();
        this.events = events;
    }

    private static final class Conn {
        final String id;
        final Socket socket;
        final BufferedWriter out;
        final ExecutorService writer = Executors.newSingleThreadExecutor();

        Conn(String id, Socket socket) throws IOException {
            this.id = id;
            this.socket = socket;
            this.out = new BufferedWriter(new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8));
        }
    }

    /* ------------------------------------------------------------------ */

    synchronized String start() throws IOException {
        if (running) return myName;
        nsd = (NsdManager) ctx.getSystemService(Context.NSD_SERVICE);
        if (nsd == null) throw new IOException("This phone has no network service discovery.");

        // Many phones drop multicast while the screen is off unless asked not to.
        WifiManager wm = (WifiManager) ctx.getSystemService(Context.WIFI_SERVICE);
        if (wm != null) {
            multicast = wm.createMulticastLock("cyanotype:discovery");
            multicast.setReferenceCounted(false);
            multicast.acquire();
        }

        server = new ServerSocket(0);
        running = true;
        pool.execute(this::acceptLoop);

        byte[] r = new byte[5];
        new SecureRandom().nextBytes(r);
        StringBuilder name = new StringBuilder("cyanotype-");
        for (byte b : r) name.append(String.format("%02x", b));
        myName = name.toString();

        NsdServiceInfo info = new NsdServiceInfo();
        info.setServiceName(myName);
        info.setServiceType(TYPE);
        info.setPort(server.getLocalPort());

        registration = new NsdManager.RegistrationListener() {
            @Override public void onServiceRegistered(NsdServiceInfo i) {
                // Android may rename us on a clash; remember the name it chose
                // so we do not try to talk to ourselves.
                if (i != null && i.getServiceName() != null) myName = i.getServiceName();
            }
            @Override public void onRegistrationFailed(NsdServiceInfo i, int code) { }
            @Override public void onServiceUnregistered(NsdServiceInfo i) { }
            @Override public void onUnregistrationFailed(NsdServiceInfo i, int code) { }
        };
        nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, registration);

        discovery = new NsdManager.DiscoveryListener() {
            @Override public void onDiscoveryStarted(String type) { }
            @Override public void onDiscoveryStopped(String type) { }
            @Override public void onStartDiscoveryFailed(String type, int code) { }
            @Override public void onStopDiscoveryFailed(String type, int code) { }

            @Override public void onServiceFound(NsdServiceInfo i) {
                if (i == null || i.getServiceName() == null) return;
                if (i.getServiceName().equals(myName)) return;
                queueResolve(i);
            }

            @Override public void onServiceLost(NsdServiceInfo i) {
                if (i == null || i.getServiceName() == null) return;
                if (peers.remove(i.getServiceName()) != null) events.peer(i.getServiceName(), false);
            }
        };
        nsd.discoverServices(TYPE, NsdManager.PROTOCOL_DNS_SD, discovery);
        return myName;
    }

    synchronized void stop() {
        if (!running) return;
        running = false;
        try { if (nsd != null && registration != null) nsd.unregisterService(registration); } catch (Exception ignored) { }
        try { if (nsd != null && discovery != null) nsd.stopServiceDiscovery(discovery); } catch (Exception ignored) { }
        registration = null;
        discovery = null;
        try { if (server != null) server.close(); } catch (IOException ignored) { }
        server = null;
        for (Conn c : conns.values()) close(c.id);
        peers.clear();
        synchronized (toResolve) { toResolve.clear(); resolving = false; }
        if (multicast != null && multicast.isHeld()) multicast.release();
        multicast = null;
    }

    /* ------------------------------------------------------------------ */
    /*  Resolving: Android resolves one service at a time                  */
    /* ------------------------------------------------------------------ */

    private void queueResolve(NsdServiceInfo i) {
        synchronized (toResolve) {
            toResolve.add(i);
            if (resolving) return;
            resolving = true;
        }
        resolveNext();
    }

    @SuppressWarnings("deprecation")
    private void resolveNext() {
        final NsdServiceInfo next;
        synchronized (toResolve) {
            next = toResolve.poll();
            if (next == null || !running) {
                resolving = false;
                return;
            }
        }
        try {
            nsd.resolveService(next, new NsdManager.ResolveListener() {
                @Override public void onServiceResolved(NsdServiceInfo si) {
                    if (si != null && si.getHost() != null && si.getServiceName() != null
                            && !si.getServiceName().equals(myName)) {
                        peers.put(si.getServiceName(), si);
                        events.peer(si.getServiceName(), true);
                    }
                    resolveNext();
                }

                @Override public void onResolveFailed(NsdServiceInfo si, int code) {
                    resolveNext();
                }
            });
        } catch (Exception e) {
            resolveNext();
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Sockets                                                            */
    /* ------------------------------------------------------------------ */

    private void acceptLoop() {
        ServerSocket s = server;
        while (running && s != null && !s.isClosed()) {
            try {
                Socket sock = s.accept();
                if (conns.size() >= MAX_CONNS) {
                    try { sock.close(); } catch (IOException ignored) { }
                    continue;
                }
                adopt(sock);
            } catch (IOException e) {
                if (!running) return;
            }
        }
    }

    private String adopt(Socket sock) throws IOException {
        sock.setSoTimeout(IDLE_MS);
        sock.setTcpNoDelay(true);
        final Conn c = new Conn(UUID.randomUUID().toString(), sock);
        conns.put(c.id, c);
        pool.execute(() -> readLoop(c));
        return c.id;
    }

    /* Lines are UTF-8 text ending in \n. A line longer than MAX_LINE closes
       the connection rather than growing a buffer for a stranger. */
    private void readLoop(Conn c) {
        try (Reader in = new InputStreamReader(c.socket.getInputStream(), StandardCharsets.UTF_8)) {
            StringBuilder line = new StringBuilder();
            char[] buf = new char[2048];
            int n;
            while ((n = in.read(buf)) != -1) {
                for (int i = 0; i < n; i++) {
                    char ch = buf[i];
                    if (ch == '\n') {
                        if (line.length() > 0) events.frame(c.id, line.toString());
                        line.setLength(0);
                    } else if (ch != '\r') {
                        if (line.length() >= MAX_LINE) throw new IOException("line too long");
                        line.append(ch);
                    }
                }
            }
        } catch (SocketTimeoutException ignored) {
            // Idle for a minute: the handshake is long over or never started.
        } catch (IOException ignored) {
        } finally {
            close(c.id);
        }
    }

    String connect(String peer) throws IOException {
        if (!running) throw new IOException("Not looking for phones on this network.");
        NsdServiceInfo si = peers.get(peer);
        if (si == null) throw new IOException("That phone is no longer on the network.");
        if (conns.size() >= MAX_CONNS) throw new IOException("Too many connections open.");
        @SuppressWarnings("deprecation") InetAddress host = si.getHost();
        Socket sock = new Socket();
        try {
            sock.connect(new InetSocketAddress(host, si.getPort()), CONNECT_MS);
            return adopt(sock);
        } catch (IOException e) {
            try { sock.close(); } catch (IOException ignored) { }
            throw e;
        }
    }

    void send(String conn, String data) throws IOException {
        final Conn c = conns.get(conn);
        if (c == null) throw new IOException("That connection has closed.");
        if (data == null || data.length() > MAX_LINE || data.indexOf('\n') >= 0) throw new IOException("Not a single line, or too long.");
        // One writer per connection keeps lines whole and in order.
        try {
            c.writer.execute(() -> {
                try {
                    c.out.write(data);
                    c.out.write('\n');
                    c.out.flush();
                } catch (IOException e) {
                    close(c.id);
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException e) {
            throw new IOException("That connection has closed.");
        }
    }

    void close(String conn) {
        final Conn c = conns.remove(conn);
        if (c == null) return;
        // Queued after any pending writes, so a last line still goes out.
        c.writer.execute(() -> {
            try { c.socket.close(); } catch (IOException ignored) { }
        });
        c.writer.shutdown();
        events.closed(c.id);
    }
}
