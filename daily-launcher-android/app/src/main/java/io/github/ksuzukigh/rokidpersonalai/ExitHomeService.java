package io.github.ksuzukigh.rokidpersonalai;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.pm.ServiceInfo;
import android.content.Intent;
import android.os.IBinder;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public final class ExitHomeService extends Service {
    private static final String STATUS_URL = "https://personal-ai.example.com/v1/status";
    private static final String CHANNEL_ID = "personal_ai_session";
    private static final int NOTIFICATION_ID = 2301;
    private static final long POLL_INTERVAL_MS = 750L;
    private static final long MAX_SESSION_MS = 20L * 60L * 1000L;
    private static final long WAKE_DURATION_MS = 3000L;
    private static final long CLOSE_GRACE_MS = 5000L;

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final AtomicBoolean polling = new AtomicBoolean(false);
    private volatile boolean stopped;
    private PowerManager.WakeLock sessionWake;
    private YodaJsaiSceneCloser sceneCloser;
    private Notification sessionNotification;

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager notifications = getSystemService(NotificationManager.class);
        if (notifications != null) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "私のAI", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("会話中の終了連絡");
            notifications.createNotificationChannel(channel);
        }
        sessionNotification = new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("私のAI")
                .setContentText("会話中")
                .setOngoing(true)
                .build();
        keepSessionVisible();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(
                NOTIFICATION_ID,
                sessionNotification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        if (polling.compareAndSet(false, true)) worker.execute(this::waitForSessionEnd);
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        stopped = true;
        YodaJsaiSceneCloser closer = sceneCloser;
        sceneCloser = null;
        if (closer != null) closer.disconnect();
        mainHandler.removeCallbacksAndMessages(null);
        releaseSessionWake();
        deleteTemporaryAixFiles();
        worker.shutdownNow();
        stopForeground(true);
        super.onDestroy();
    }

    @SuppressWarnings("deprecation")
    private void keepSessionVisible() {
        PowerManager power = getSystemService(PowerManager.class);
        if (power == null) return;
        sessionWake = power.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP,
                "RokidPersonalAI:keepSessionVisible");
        sessionWake.setReferenceCounted(false);
        sessionWake.acquire(MAX_SESSION_MS);
    }

    private void releaseSessionWake() {
        PowerManager.WakeLock wake = sessionWake;
        sessionWake = null;
        if (wake != null && wake.isHeld()) wake.release();
    }

    private void deleteTemporaryAixFiles() {
        File directory = getExternalFilesDir(null);
        if (directory == null) return;
        File[] files = directory.listFiles(
                (parent, name) -> name.startsWith("personal-ai-") && name.endsWith(".aix"));
        if (files == null) return;
        for (File file : files) file.delete();
    }

    private void waitForSessionEnd() {
        long deadline = SystemClock.elapsedRealtime() + MAX_SESSION_MS;
        boolean seenActive = false;
        while (!stopped && SystemClock.elapsedRealtime() < deadline) {
            Boolean active = readSessionStatus();
            if (Boolean.TRUE.equals(active)) {
                seenActive = true;
            } else if (Boolean.FALSE.equals(active) && seenActive) {
                wakeAndCloseAiui();
                return;
            }
            SystemClock.sleep(POLL_INTERVAL_MS);
        }
        stopSelf();
    }

    private Boolean readSessionStatus() {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(STATUS_URL).openConnection();
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Authorization", "Bearer " + BuildConfig.BOOTSTRAP_TOKEN);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setConnectTimeout(3000);
            connection.setReadTimeout(3000);
            connection.setDoOutput(true);
            connection.getOutputStream().write("{}".getBytes(StandardCharsets.UTF_8));
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) return null;
            String response = readSmall(connection.getInputStream());
            if (response.contains("\"active\":true")) return true;
            if (response.contains("\"active\":false")) return false;
        } catch (Exception ignored) {
            // A temporary network interruption must not force the user out of the conversation.
        } finally {
            if (connection != null) connection.disconnect();
        }
        return null;
    }

    private String readSmall(InputStream input) throws Exception {
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[256];
            int count;
            while ((count = stream.read(buffer)) != -1) {
                if (output.size() + count > 2048) throw new IllegalStateException("status response is too large");
                output.write(buffer, 0, count);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    @SuppressWarnings("deprecation")
    private void wakeAndCloseAiui() {
        PowerManager power = getSystemService(PowerManager.class);
        if (power != null) {
            PowerManager.WakeLock wake = power.newWakeLock(
                    PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP |
                            PowerManager.ON_AFTER_RELEASE,
                    "RokidPersonalAI:showHome");
            wake.acquire(WAKE_DURATION_MS);
        }
        mainHandler.post(() -> {
            if (stopped) return;
            sceneCloser = new YodaJsaiSceneCloser(this, success -> {
                if (!success) returnHomeAsFallback();
                mainHandler.postDelayed(this::stopSelf, CLOSE_GRACE_MS);
            });
            if (!sceneCloser.requestClose()) {
                returnHomeAsFallback();
                mainHandler.postDelayed(this::stopSelf, CLOSE_GRACE_MS);
            }
        });
    }

    private void returnHomeAsFallback() {
        Intent home = new Intent(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_HOME)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            startActivity(home);
        } catch (RuntimeException ignored) {
            // YodaOS normally returns through the resumed launcher after closing the JS AI scene.
        }
    }
}
