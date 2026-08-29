package io.github.ksuzukigh.rokidpersonalai;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.os.PowerManager;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class LauncherActivity extends Activity {
    private static final String BOOTSTRAP_URL = "https://personal-ai.example.com/v1/bootstrap";
    private static final String END_URL = "https://personal-ai.example.com/v1/end";
    private static final String STATUS_URL = "https://personal-ai.example.com/v1/status";
    private static final String AIUI_PACKAGE = "com.rokid.os.sprite.assistserver";
    private static final String AIUI_SERVICE = "com.rokid.os.sprite.jsai.JsaiService";
    private static final String AIUI_ACTION = "com.rokid.os.sprite.jsai.OPEN_PAGE";
    private static final int MAX_AIX_BYTES = 512 * 1024;
    private static final long HOME_WAKE_MS = 3000L;
    private static final long POLL_INTERVAL_MS = 750L;
    private static final long MAX_SESSION_MS = 20L * 60L * 1000L;

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private TextView status;
    private File currentAix;
    private boolean starting;
    private boolean launchedAiui;
    private boolean leftForAiui;
    private boolean ending;
    private boolean exitRequested;
    private YodaJsaiSceneCloser sceneCloser;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(buildStatusView());
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (launchedAiui && leftForAiui) {
            if (!ending) {
                ending = true;
                worker.execute(this::notifySessionEnded);
                deleteTemporaryAix();
                showHomeAndFinish();
            }
            return;
        }
        if (starting || launchedAiui) return;
        starting = true;
        status.setText("準備中…");
        try {
            startForegroundService(new Intent(this, ExitHomeService.class));
        } catch (RuntimeException error) {
            starting = false;
            status.setText("接続できません\n時間をおいて開き直してください");
            return;
        }
        worker.execute(this::prepareAndOpenAiui);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (starting || launchedAiui) leftForAiui = true;
    }

    @Override
    protected void onDestroy() {
        YodaJsaiSceneCloser closer = sceneCloser;
        sceneCloser = null;
        if (closer != null) closer.disconnect();
        worker.shutdownNow();
        if (!launchedAiui) {
            stopService(new Intent(this, ExitHomeService.class));
            deleteTemporaryAix();
        }
        super.onDestroy();
    }

    private void closeAiuiAfterSessionEnd() {
        if (exitRequested || ending || isFinishing()) return;
        exitRequested = true;
        sceneCloser = new YodaJsaiSceneCloser(this, success -> {
            if (!success) exitRequested = false;
            ending = true;
            deleteTemporaryAix();
            showHomeAndFinish();
        });
        if (!sceneCloser.requestClose()) {
            exitRequested = false;
            ending = true;
            deleteTemporaryAix();
            showHomeAndFinish();
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
    }

    private void prepareAndOpenAiui() {
        try {
            currentAix = downloadAix();
            Intent intent = new Intent(AIUI_ACTION);
            intent.setClassName(AIUI_PACKAGE, AIUI_SERVICE);
            intent.putExtra("open_params", currentAix.getAbsolutePath());
            intent.putExtra("test_run_id", "personal-ai-mobile-" + UUID.randomUUID());
            ComponentName component = startService(intent);
            if (component == null) throw new IllegalStateException("AIUI service did not start");
            runOnUiThread(() -> launchedAiui = true);
            waitForSessionEnd();
        } catch (Exception error) {
            stopService(new Intent(this, ExitHomeService.class));
            deleteTemporaryAix();
            runOnUiThread(() -> {
                starting = false;
                status.setText("接続できません\n時間をおいて開き直してください");
            });
        }
    }

    private void waitForSessionEnd() {
        long deadline = SystemClock.elapsedRealtime() + MAX_SESSION_MS;
        boolean seenActive = false;
        while (!Thread.currentThread().isInterrupted() &&
                SystemClock.elapsedRealtime() < deadline) {
            Boolean active = readSessionStatus();
            if (Boolean.TRUE.equals(active)) {
                seenActive = true;
            } else if (Boolean.FALSE.equals(active) && seenActive) {
                runOnUiThread(this::closeAiuiAfterSessionEnd);
                return;
            }
            SystemClock.sleep(POLL_INTERVAL_MS);
        }
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
            String response = new String(readLimited(connection.getInputStream(), 2048), StandardCharsets.UTF_8);
            if (response.contains("\"active\":true")) return true;
            if (response.contains("\"active\":false")) return false;
        } catch (Exception ignored) {
            // A temporary network interruption must not force the user out of the conversation.
        } finally {
            if (connection != null) connection.disconnect();
        }
        return null;
    }

    private File downloadAix() throws Exception {
        if (BuildConfig.BOOTSTRAP_TOKEN == null || BuildConfig.BOOTSTRAP_TOKEN.length() < 32) {
            throw new IllegalStateException("bootstrap token is unavailable");
        }
        File directory = getExternalFilesDir(null);
        if (directory == null) directory = getExternalFilesDir("personal-ai");
        if (directory == null) throw new IllegalStateException("external app storage is unavailable");
        if (!directory.exists() && !directory.mkdirs()) {
            throw new IllegalStateException("external app storage could not be created");
        }
        deleteStaleAixFiles(directory);
        File output = new File(directory, "personal-ai-" + UUID.randomUUID() + ".aix");

        HttpURLConnection connection = (HttpURLConnection) new URL(BOOTSTRAP_URL).openConnection();
        connection.setRequestMethod("POST");
        connection.setRequestProperty("Authorization", "Bearer " + BuildConfig.BOOTSTRAP_TOKEN);
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(60000);
        connection.setDoOutput(true);
        connection.getOutputStream().write("{}".getBytes(StandardCharsets.UTF_8));
        try {
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) {
                throw new IllegalStateException("bootstrap request failed");
            }
            String type = connection.getContentType();
            if (type == null || !type.startsWith("application/vnd.rokid.aix")) {
                throw new IllegalStateException("bootstrap response type is invalid");
            }
            byte[] payload = readLimited(connection.getInputStream());
            if (payload.length == 0) throw new IllegalStateException("bootstrap response is empty");
            try (FileOutputStream stream = new FileOutputStream(output, false)) {
                stream.write(payload);
                stream.getFD().sync();
            }
            return output;
        } finally {
            connection.disconnect();
        }
    }

    private void deleteStaleAixFiles(File directory) {
        File[] files = directory.listFiles((parent, name) -> name.startsWith("personal-ai-") && name.endsWith(".aix"));
        if (files == null) return;
        for (File file : files) file.delete();
    }

    private void notifySessionEnded() {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(END_URL).openConnection();
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Authorization", "Bearer " + BuildConfig.BOOTSTRAP_TOKEN);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(5000);
            connection.setDoOutput(true);
            connection.getOutputStream().write("{}".getBytes(StandardCharsets.UTF_8));
            connection.getResponseCode();
        } catch (Exception ignored) {
            // The short-lived Mac session also has its own expiry boundary.
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private byte[] readLimited(InputStream input) throws Exception {
        return readLimited(input, MAX_AIX_BYTES);
    }

    private byte[] readLimited(InputStream input, int maximumBytes) throws Exception {
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int total = 0;
            int count;
            while ((count = stream.read(buffer)) != -1) {
                total += count;
                if (total > maximumBytes) throw new IllegalStateException("response is too large");
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }

    private void deleteTemporaryAix() {
        File file = currentAix;
        currentAix = null;
        if (file != null && file.exists()) file.delete();
    }

    @SuppressWarnings("deprecation")
    private void showHomeAndFinish() {
        stopService(new Intent(this, ExitHomeService.class));
        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        if (power != null) {
            PowerManager.WakeLock wake = power.newWakeLock(
                    PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP |
                            PowerManager.ON_AFTER_RELEASE,
                    "RokidPersonalAI:showHome");
            wake.acquire(HOME_WAKE_MS);
        }
        Intent home = new Intent(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_HOME)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(home);
        finishAndRemoveTask();
    }

    private LinearLayout buildStatusView() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setGravity(Gravity.CENTER);
        layout.setPadding(36, 24, 36, 24);
        layout.setBackgroundColor(Color.BLACK);

        TextView title = text("私のAI", 28);
        status = text("準備中…", 19);
        layout.addView(title);
        layout.addView(status);
        return layout;
    }

    private TextView text(String value, int sizeSp) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextColor(Color.rgb(64, 255, 94));
        view.setTextSize(sizeSp);
        view.setGravity(Gravity.CENTER);
        view.setPadding(0, 12, 0, 12);
        return view;
    }
}
