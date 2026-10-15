import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
export async function verifyFirebasePhoneToken(idToken) {
    const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
    if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
        throw new Error('FIREBASE_PROVIDER_NOT_CONFIGURED');
    }
    if (!getApps().length) {
        initializeApp({
            credential: cert({
                projectId: FIREBASE_PROJECT_ID,
                clientEmail: FIREBASE_CLIENT_EMAIL,
                privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            }),
        });
    }
    const decoded = await getAuth().verifyIdToken(idToken, true);
    if (decoded.firebase?.sign_in_provider !== 'phone' || !decoded.phone_number) {
        throw new Error('FIREBASE_NOT_PHONE_IDENTITY');
    }
    return { uid: decoded.uid, phone: decoded.phone_number };
}
