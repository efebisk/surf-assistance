import { db } from './firebase.js';
import {
    collection, getDocs,
    doc, addDoc, updateDoc, deleteDoc, setDoc,
} from 'firebase/firestore';

export async function loadStudents() {
    const snap = await getDocs(collection(db, 'students'));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function loadAttendance() {
    const snap = await getDocs(collection(db, 'attendance'));
    const result = {};
    snap.docs.forEach(d => { result[d.id] = d.data().names || []; });
    return result;
}

export async function addStudentDoc(data) {
    const ref = await addDoc(collection(db, 'students'), data);
    return ref.id;
}

export async function updateStudentDoc(id, data) {
    await updateDoc(doc(db, 'students', id), data);
}

export async function deleteStudentDoc(id) {
    await deleteDoc(doc(db, 'students', id));
}

export async function setAttendanceDoc(date, names) {
    await setDoc(doc(db, 'attendance', date), { names });
}

export async function deleteAttendanceDoc(date) {
    await deleteDoc(doc(db, 'attendance', date));
}
