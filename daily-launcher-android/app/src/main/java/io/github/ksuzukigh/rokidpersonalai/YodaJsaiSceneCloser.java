package io.github.ksuzukigh.rokidpersonalai;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.IBinder;
import android.os.Parcel;
import android.os.RemoteException;

final class YodaJsaiSceneCloser implements ServiceConnection {
    interface ResultListener {
        void onResult(boolean success);
    }

    private static final String ASSIST_PACKAGE = "com.rokid.os.sprite.assistserver";
    private static final String ASSIST_SERVICE = "com.rokid.os.sprite.assist.MasterAssistService";
    private static final String ASSIST_ACTION = "com.rokid.os.sprite.assist.MasterAssistService";
    private static final String ASSIST_DESCRIPTOR =
            "com.rokid.os.sprite.assist.server.IAssistServer";
    private static final int TRANSACTION_CONTROL_MSG_JSON = 3;
    private static final String CLOSE_JSAI_JSON =
            "{\"type\":\"cmd_scene_stop_by_launcher\","
                    + "\"data\":{\"sceneKey\":\"jsai\",\"status\":false}}";

    private final Context context;
    private final ResultListener listener;
    private boolean bound;
    private boolean completed;

    YodaJsaiSceneCloser(Context context, ResultListener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
    }

    boolean requestClose() {
        Intent intent = new Intent(ASSIST_ACTION)
                .setClassName(ASSIST_PACKAGE, ASSIST_SERVICE);
        try {
            bound = context.bindService(intent, this, Context.BIND_AUTO_CREATE);
            return bound;
        } catch (RuntimeException error) {
            return false;
        }
    }

    @Override
    public void onServiceConnected(ComponentName name, IBinder service) {
        boolean success = sendCloseCommand(service);
        disconnect();
        complete(success);
    }

    @Override
    public void onServiceDisconnected(ComponentName name) {
        disconnect();
        complete(false);
    }

    void disconnect() {
        if (!bound) return;
        bound = false;
        try {
            context.unbindService(this);
        } catch (RuntimeException ignored) {
            // The remote system service may already have disconnected.
        }
    }

    private boolean sendCloseCommand(IBinder service) {
        if (service == null) return false;
        Parcel data = Parcel.obtain();
        Parcel reply = Parcel.obtain();
        try {
            data.writeInterfaceToken(ASSIST_DESCRIPTOR);
            data.writeString(context.getPackageName());
            data.writeString(CLOSE_JSAI_JSON);
            if (!service.transact(TRANSACTION_CONTROL_MSG_JSON, data, reply, 0)) return false;
            reply.readException();
            return true;
        } catch (RemoteException | RuntimeException error) {
            return false;
        } finally {
            reply.recycle();
            data.recycle();
        }
    }

    private void complete(boolean success) {
        if (completed) return;
        completed = true;
        listener.onResult(success);
    }
}
