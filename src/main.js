import { auth } from './firebase.js';
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'firebase/auth';
import {
    loadStudents, loadAttendance,
    addStudentDoc, updateStudentDoc, deleteStudentDoc,
    setAttendanceDoc, deleteAttendanceDoc,
} from './db.js';

// --- State ---
let studentsData   = [];
let attendance     = {};
let selectedPerson = '';
let rechargeTarget = '';
let debtTarget     = '';

// --- Auth ---
async function login() {
    const email    = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errEl    = document.getElementById('loginError');
    const btn      = document.getElementById('loginBtn');

    errEl.style.display = 'none';
    btn.disabled = true;
    btn.textContent = 'Ingresando...';

    try {
        await signInWithEmailAndPassword(auth, email, password);
    } catch {
        errEl.textContent = 'Email o contraseña incorrectos';
        errEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Ingresar';
    }
}

async function logout() {
    await signOut(auth);
}

// --- Helpers ---
function getStudent(name) {
    return studentsData.find(s => s.name === name);
}

function getActiveStudents() {
    return studentsData.filter(s => s.active);
}

function getInactiveStudents() {
    return studentsData.filter(s => !s.active);
}

function getTotalClasses(name) {
    let count = 0;
    for (const date in attendance) {
        if (attendance[date].includes(name)) count++;
    }
    return count;
}

function packBadgeClass(pack) {
    if (pack <= 0) return 'badge-danger';
    if (pack <= 3) return 'badge-warn';
    return 'badge-ok';
}

const AVATAR_COLORS = [
    '#0096a0','#006d75','#0d6efd','#6610f2',
    '#198754','#d63384','#fd7e14','#0dcaf0',
];

function avatarColor(name) {
    let hash = 0;
    for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function avatarInitials(name) {
    const parts = name.trim().split(' ').filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
}

function formatDate(dateStr) {
    const [y, m, d] = dateStr.split('-');
    return `${d}/${m}/${y}`;
}

function esc(str) {
    return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function getISOWeekString(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
    const week1 = new Date(d.getFullYear(), 0, 4);
    const weekNum = 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
    return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function getWeekDates(weekStr) {
    if (!weekStr) return [];
    const [year, week] = weekStr.split('-W').map(Number);
    const jan4 = new Date(year, 0, 4);
    const start = new Date(jan4);
    start.setDate(jan4.getDate() - (jan4.getDay() || 7) + 1 + (week - 1) * 7);
    const dates = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        dates.push(d.toISOString().split('T')[0]);
    }
    return dates;
}

// --- Search ---
function initSearch() {
    const searchInput   = document.getElementById('personSearch');
    const suggestionsEl = document.getElementById('suggestions');

    searchInput.addEventListener('input', function () {
        const q = this.value.trim().toLowerCase();
        suggestionsEl.innerHTML = '';
        if (!q) { suggestionsEl.style.display = 'none'; return; }

        const matches = getActiveStudents().filter(s => s.name.toLowerCase().includes(q));

        matches.forEach(s => {
            const div = document.createElement('div');
            const meta = s.debt > 0
                ? `<span class="meta-info badge badge-debt">Debe ${s.debt}</span>`
                : `<span class="meta-info badge ${packBadgeClass(s.pack)}">${s.pack} restantes</span>`;
            div.innerHTML = `${s.name} ${meta}`;
            div.onclick = () => selectPerson(s.name);
            suggestionsEl.appendChild(div);
        });

        const exactMatch = matches.some(s => s.name.toLowerCase() === q);
        if (!exactMatch) {
            const div = document.createElement('div');
            div.className = 'new-person';
            div.textContent = `+ Crear "${this.value.trim()}"`;
            div.onclick = () => openCreateFromSearch(searchInput.value.trim());
            suggestionsEl.appendChild(div);
        }

        suggestionsEl.style.display = suggestionsEl.children.length ? 'block' : 'none';
    });

    searchInput.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const q     = this.value.trim().toLowerCase();
        const exact = getActiveStudents().find(s => s.name.toLowerCase() === q);
        if (exact) {
            selectPerson(exact.name);
            addAttendance();
        } else if (this.value.trim()) {
            openCreateFromSearch(this.value.trim());
        }
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-wrapper')) suggestionsEl.style.display = 'none';
    });
}

function selectPerson(name) {
    selectedPerson = name;
    document.getElementById('personSearch').value = name;
    document.getElementById('suggestions').style.display = 'none';
}

async function openCreateFromSearch(name) {
    const existing = getStudent(name);
    if (existing && existing.active) { selectPerson(name); return; }
    if (existing && !existing.active) {
        const ok = await showConfirm(
            `"${name}" existe pero está inactivo.`,
            { title: '¿Reactivar alumno?', okLabel: 'Reactivar', okClass: 'btn-success' }
        );
        if (ok) {
            existing.active = true;
            selectPerson(name);
            renderAll();
            await updateStudentDoc(existing.id, { active: true });
        }
        return;
    }

    const packStr = await showPrompt(
        `Crear alumno`,
        `Nuevo alumno: "${name}"`,
        'Pack inicial (clases)',
        '0'
    );
    if (packStr === null) return;
    const pack = Math.max(0, parseInt(packStr) || 0);
    const data = { name, pack, debt: 0, active: true };
    const id   = await addStudentDoc(data);
    studentsData.push({ id, ...data });
    studentsData.sort((a, b) => a.name.localeCompare(b.name));
    selectPerson(name);
    document.getElementById('suggestions').style.display = 'none';
    renderStudents();
}

// --- Attendance ---
async function addAttendance() {
    const date = document.getElementById('classDate').value;
    const name = document.getElementById('personSearch').value.trim();
    if (!date) { await showAlert('Seleccioná una fecha'); return; }
    if (!name) { await showAlert('Seleccioná un alumno'); return; }

    const student = getStudent(name);
    if (!student)        { await showAlert('El alumno no existe. Crealo primero.'); return; }
    if (!student.active) { await showAlert(`${name} está inactivo. Reactivalo primero.`); return; }

    if (!attendance[date]) attendance[date] = [];
    if (attendance[date].includes(name)) {
        document.getElementById('personSearch').value = '';
        selectedPerson = '';
        await showAlert(`${name} ya tiene asistencia el ${formatDate(date)}`);
        return;
    }

    const updates = {};
    if (student.pack > 0) {
        student.pack--;
        updates.pack = student.pack;
    } else {
        student.debt = (student.debt || 0) + 1;
        updates.debt = student.debt;
    }

    attendance[date].push(name);
    document.getElementById('personSearch').value = '';
    selectedPerson = '';
    renderAll();

    await Promise.all([
        updateStudentDoc(student.id, updates),
        setAttendanceDoc(date, attendance[date]),
    ]);

}

async function removeAttendance(date, name) {
    if (!attendance[date] || !attendance[date].includes(name)) return;

    attendance[date] = attendance[date].filter(n => n !== name);

    const student = getStudent(name);
    const updates = {};
    if (student) {
        if (student.debt > 0) {
            student.debt--;
            updates.debt = student.debt;
        } else {
            student.pack++;
            updates.pack = student.pack;
        }
    }

    renderAll();

    const ops = [updateStudentDoc(student.id, updates)];
    if (attendance[date].length === 0) {
        delete attendance[date];
        ops.push(deleteAttendanceDoc(date));
    } else {
        ops.push(setAttendanceDoc(date, attendance[date]));
    }
    await Promise.all(ops);
}

// --- Students ---
async function addStudent() {
    const nameInput = document.getElementById('newStudentName');
    const packInput = document.getElementById('newStudentPack');
    const name = nameInput.value.trim();
    const pack = Math.max(0, parseInt(packInput.value) || 0);

    if (!name) return;
    if (getStudent(name)) { await showAlert('Ya existe un alumno con ese nombre.'); return; }

    const data = { name, pack, debt: 0, active: true };
    const id   = await addStudentDoc(data);
    studentsData.push({ id, ...data });
    studentsData.sort((a, b) => a.name.localeCompare(b.name));

    nameInput.value = '';
    packInput.value = '';
    renderStudents();
}

async function toggleStudentStatus(name) {
    const student = getStudent(name);
    if (!student) return;
    const deactivating = student.active;
    const ok = await showConfirm(
        `${name} pasará a ${deactivating ? 'inactivo' : 'activo'}.`,
        {
            title: deactivating ? '¿Desactivar alumno?' : '¿Reactivar alumno?',
            okLabel: deactivating ? 'Desactivar' : 'Reactivar',
            okClass: deactivating ? 'btn-warning' : 'btn-success',
        }
    );
    if (!ok) return;
    student.active = !student.active;
    renderAll();
    await updateStudentDoc(student.id, { active: student.active });
}

async function deleteStudent(name) {
    const ok = await showConfirm(
        'Se borrarán también todas sus asistencias. Esta acción no se puede deshacer.',
        { title: `¿Eliminar a ${name}?`, okLabel: 'Eliminar', okClass: 'btn-danger' }
    );
    if (!ok) return;
    const student = getStudent(name);

    const ops = [deleteStudentDoc(student.id)];
    for (const date in attendance) {
        if (attendance[date].includes(name)) {
            attendance[date] = attendance[date].filter(n => n !== name);
            if (attendance[date].length === 0) {
                delete attendance[date];
                ops.push(deleteAttendanceDoc(date));
            } else {
                ops.push(setAttendanceDoc(date, attendance[date]));
            }
        }
    }

    studentsData = studentsData.filter(s => s.name !== name);
    renderAll();
    await Promise.all(ops);
}

// --- Modal: recargar pack ---
function openRechargeModal(name) {
    rechargeTarget = name;
    const student = getStudent(name);
    document.getElementById('rechargeInfo').textContent =
        `${name} — Clases restantes: ${student.pack}`;
    document.getElementById('rechargeAmount').value = '';
    document.getElementById('rechargeModal').classList.add('show');
    document.getElementById('rechargeAmount').focus();
}

async function confirmRecharge() {
    const amount = parseInt(document.getElementById('rechargeAmount').value);
    if (!amount || amount < 1) { await showAlert('Ingresá una cantidad válida.'); return; }
    const student = getStudent(rechargeTarget);
    if (!student) return;
    student.pack += amount;
    closeModal('rechargeModal');
    renderAll();
    await updateStudentDoc(student.id, { pack: student.pack });
}

// --- Modal: cobrar deuda ---
function openDebtModal(name) {
    debtTarget = name;
    const student = getStudent(name);
    document.getElementById('debtInfo').textContent =
        `${name} debe ${student.debt} clase${student.debt !== 1 ? 's' : ''}.`;
    document.getElementById('debtPayAmount').value = student.debt;
    document.getElementById('debtModal').classList.add('show');
    document.getElementById('debtPayAmount').focus();
}

async function confirmPayDebt() {
    const student = getStudent(debtTarget);
    if (!student) return;
    const amount = parseInt(document.getElementById('debtPayAmount').value);
    if (!amount || amount < 1) { await showAlert('Ingresá una cantidad válida.'); return; }
    if (amount > student.debt) { await showAlert(`La deuda es de ${student.debt} clase${student.debt !== 1 ? 's' : ''}. No podés saldar más de lo que debe.`); return; }
    student.debt -= amount;
    closeModal('debtModal');
    renderAll();
    await updateStudentDoc(student.id, { debt: student.debt });
}

// --- Modal helpers ---
function closeModal(id) {
    document.getElementById(id).classList.remove('show');
    rechargeTarget = '';
    debtTarget     = '';
}

// --- Tabs ---
function switchTab(tab, btn) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    ['attendance', 'students', 'weekly', 'inactive'].forEach(t => {
        document.getElementById('tab-' + t).style.display = t === tab ? '' : 'none';
    });
    if (tab === 'weekly')   renderWeeklySummary();
    if (tab === 'inactive') renderInactive();
}

// --- Render ---
function renderAll() {
    renderDayAttendance();
    renderAttendanceHistory();
    renderStudents();
    renderWeeklySummary();
    renderInactive();
}

function renderDayAttendance() {
    const date = document.getElementById('classDate').value;
    const el   = document.getElementById('dayAttendance');
    const list = attendance[date] || [];

    if (!list.length) {
        el.innerHTML = `<p class="empty-msg">No hay asistencias para ${date ? formatDate(date) : 'esta fecha'}</p>`;
        return;
    }

    let alerts = '';
    list.forEach(name => {
        const s = getStudent(name);
        if (!s) return;
        if (s.debt > 0) {
            alerts += `<div class="alert-banner danger">${name} tiene deuda de ${s.debt} clase${s.debt !== 1 ? 's' : ''}</div>`;
        } else if (s.pack > 0 && s.pack <= 3) {
            alerts += `<div class="alert-banner">A ${name} le quedan ${s.pack} clase${s.pack !== 1 ? 's' : ''}</div>`;
        } else if (s.pack === 0) {
            alerts += `<div class="alert-banner danger">${name} no tiene clases en el pack</div>`;
        }
    });

    el.innerHTML = `
        <strong>Asistentes (${formatDate(date)}): ${list.length}</strong>
        ${alerts}
        <div class="table-wrap">
        <table><thead><tr><th>Alumno</th><th>Pack</th><th>Deuda</th><th></th></tr></thead><tbody>
        ${list.map(name => {
            const s        = getStudent(name);
            const packVal  = s ? s.pack       : '?';
            const debtVal  = s ? (s.debt || 0) : '?';
            const packBadge = s ? `<span class="badge ${packBadgeClass(s.pack)}">${packVal}</span>` : packVal;
            const debtBadge = (s && debtVal > 0)
                ? `<span class="badge badge-debt">${debtVal}</span>`
                : `<span class="badge">${debtVal}</span>`;
            return `<tr>
                <td>${name}</td>
                <td>${packBadge}</td>
                <td>${debtBadge}</td>
                <td><button class="btn-danger" onclick="removeAttendance('${date}','${esc(name)}')">Quitar</button></td>
            </tr>`;
        }).join('')}
        </tbody></table>
        </div>`;
}

function renderAttendanceHistory() {
    const el      = document.getElementById('attendanceHistory');
    const weekStr = document.getElementById('filterWeek').value;
    const dates   = Object.keys(attendance)
        .filter(d => getWeekDates(weekStr).includes(d))
        .sort().reverse();

    if (!dates.length) {
        el.innerHTML = '<p class="empty-msg">No hay asistencias en esta semana</p>';
        return;
    }

    el.innerHTML = dates.map(date => {
        const list = attendance[date];
        return `<div style="margin-top:12px;">
            <strong>${formatDate(date)}</strong> — ${list.length} asistente${list.length !== 1 ? 's' : ''}
            <div style="margin-top:4px;">${list.map(n => `<span class="badge">${n}</span>`).join(' ')}</div>
        </div>`;
    }).join('');
}

function renderStudents() {
    const body   = document.getElementById('studentsBody');
    const cards  = document.getElementById('studentsCards');
    const active = getActiveStudents();

    if (!active.length) {
        body.innerHTML  = '<tr><td colspan="5" class="empty-msg">No hay alumnos activos</td></tr>';
        cards.innerHTML = '<p class="empty-msg">No hay alumnos activos</p>';
        return;
    }

    body.innerHTML = active.map(s => {
        const total     = getTotalClasses(s.name);
        const debt      = s.debt || 0;
        const debtBadge = debt > 0
            ? `<span class="badge badge-debt">${debt}</span>`
            : `<span class="badge">0</span>`;
        const debtBtn = debt > 0
            ? `<button class="btn-debt" onclick="openDebtModal('${esc(s.name)}')">Cobrar</button>`
            : '';
        return `<tr>
            <td><span class="status-dot active"></span>${s.name}</td>
            <td><span class="badge ${packBadgeClass(s.pack)}">${s.pack}</span></td>
            <td>${debtBadge}</td>
            <td><span class="badge">${total}</span></td>
            <td class="actions-cell">
                <button class="btn-primary btn-sm" onclick="openRechargeModal('${esc(s.name)}')">Recargar</button>
                ${debtBtn}
                <button class="btn-warning" onclick="toggleStudentStatus('${esc(s.name)}')">Desactivar</button>
                <button class="btn-danger"  onclick="deleteStudent('${esc(s.name)}')">Eliminar</button>
            </td>
        </tr>`;
    }).join('');

    cards.innerHTML = active.map(s => {
        const total = getTotalClasses(s.name);
        const debt  = s.debt || 0;
        const debtBadge = debt > 0
            ? `<span class="badge badge-debt">Debe ${debt}</span>`
            : '';
        const debtBtn = debt > 0
            ? `<button class="btn-debt btn-sm" onclick="openDebtModal('${esc(s.name)}')">Cobrar deuda</button>`
            : '';
        return `<div class="student-card">
            <div class="student-card-header">
                <div class="student-avatar" style="background:${avatarColor(s.name)}">${avatarInitials(s.name)}</div>
                <div class="student-info">
                    <div class="student-name">${s.name}</div>
                    <div class="student-meta">
                        <span class="badge ${packBadgeClass(s.pack)}">${s.pack} clases</span>
                        ${debtBadge}
                        <span class="badge badge-inactive">${total} asistidas</span>
                    </div>
                </div>
            </div>
            <div class="student-card-actions">
                <button class="btn-primary btn-sm" onclick="openRechargeModal('${esc(s.name)}')">Recargar</button>
                ${debtBtn}
                <button class="btn-warning btn-sm" onclick="toggleStudentStatus('${esc(s.name)}')">Desactivar</button>
                <button class="btn-danger btn-sm" onclick="deleteStudent('${esc(s.name)}')">Eliminar</button>
            </div>
        </div>`;
    }).join('');
}

function renderInactive() {
    const body     = document.getElementById('inactiveBody');
    const cards    = document.getElementById('inactiveCards');
    const inactive = getInactiveStudents();

    if (!inactive.length) {
        body.innerHTML  = '<tr><td colspan="5" class="empty-msg">No hay alumnos inactivos</td></tr>';
        cards.innerHTML = '<p class="empty-msg">No hay alumnos inactivos</p>';
        return;
    }

    body.innerHTML = inactive.map(s => {
        const total = getTotalClasses(s.name);
        const debt  = s.debt || 0;
        return `<tr style="opacity:0.7;">
            <td><span class="status-dot inactive"></span>${s.name}</td>
            <td><span class="badge badge-inactive">${s.pack}</span></td>
            <td>${debt > 0 ? `<span class="badge badge-debt">${debt}</span>` : `<span class="badge">0</span>`}</td>
            <td><span class="badge">${total}</span></td>
            <td class="actions-cell">
                <button class="btn-success btn-sm" onclick="toggleStudentStatus('${esc(s.name)}')">Reactivar</button>
                <button class="btn-danger"         onclick="deleteStudent('${esc(s.name)}')">Eliminar</button>
            </td>
        </tr>`;
    }).join('');

    cards.innerHTML = inactive.map(s => {
        const total = getTotalClasses(s.name);
        const debt  = s.debt || 0;
        return `<div class="student-card" style="opacity:0.75;">
            <div class="student-card-header">
                <div class="student-avatar" style="background:#8fa3b0">${avatarInitials(s.name)}</div>
                <div class="student-info">
                    <div class="student-name">${s.name}</div>
                    <div class="student-meta">
                        <span class="badge badge-inactive">${s.pack} clases</span>
                        ${debt > 0 ? `<span class="badge badge-debt">Debe ${debt}</span>` : ''}
                        <span class="badge badge-inactive">${total} asistidas</span>
                    </div>
                </div>
            </div>
            <div class="student-card-actions">
                <button class="btn-success btn-sm" onclick="toggleStudentStatus('${esc(s.name)}')">Reactivar</button>
                <button class="btn-danger btn-sm" onclick="deleteStudent('${esc(s.name)}')">Eliminar</button>
            </div>
        </div>`;
    }).join('');
}

function renderWeeklySummary() {
    const body      = document.getElementById('weeklyBody');
    const weekStr   = document.getElementById('summaryWeek').value;
    const weekDates = getWeekDates(weekStr);

    const counts = {};
    weekDates.forEach(date => {
        (attendance[date] || []).forEach(name => {
            counts[name] = (counts[name] || 0) + 1;
        });
    });

    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (!entries.length) {
        body.innerHTML = '<tr><td colspan="2" class="empty-msg">Sin asistencias esta semana</td></tr>';
        return;
    }
    body.innerHTML = entries.map(([name, count]) =>
        `<tr><td>${name}</td><td><span class="badge">${count}</span></td></tr>`
    ).join('');
}

// --- Custom dialogs ---
function showAlert(message) {
    return new Promise(resolve => {
        document.getElementById('alertMessage').textContent = message;
        document.getElementById('alertModal').classList.add('show');
        window._alertResolve = resolve;
    });
}

function closeAlert() {
    document.getElementById('alertModal').classList.remove('show');
    if (window._alertResolve) { window._alertResolve(); window._alertResolve = null; }
}

function showConfirm(message, { title = '¿Estás seguro?', okLabel = 'Confirmar', okClass = 'btn-primary' } = {}) {
    return new Promise(resolve => {
        document.getElementById('confirmTitle').textContent    = title;
        document.getElementById('confirmMessage').textContent  = message;
        const btn = document.getElementById('confirmOkBtn');
        btn.textContent = okLabel;
        btn.className   = `${okClass} btn-sm`;
        document.getElementById('confirmModal').classList.add('show');
        window._confirmResolve = resolve;
    });
}

function closeConfirm(result) {
    document.getElementById('confirmModal').classList.remove('show');
    if (window._confirmResolve) { window._confirmResolve(result); window._confirmResolve = null; }
}

function showPrompt(title, message, inputLabel, defaultValue = '0') {
    return new Promise(resolve => {
        document.getElementById('promptTitle').textContent      = title;
        document.getElementById('promptMessage').textContent    = message;
        document.getElementById('promptInputLabel').textContent = inputLabel;
        const input = document.getElementById('promptInput');
        input.value = defaultValue;
        document.getElementById('promptModal').classList.add('show');
        setTimeout(() => input.focus(), 50);
        input.onkeydown = e => { if (e.key === 'Enter') closePrompt(true); };
        window._promptResolve = resolve;
    });
}

function closePrompt(confirmed) {
    const value = document.getElementById('promptInput').value;
    document.getElementById('promptModal').classList.remove('show');
    if (window._promptResolve) {
        window._promptResolve(confirmed ? value : null);
        window._promptResolve = null;
    }
}

// --- Screen helpers ---
function showScreen(screen) {
    ['loading-screen', 'login-screen', 'app-screen'].forEach(id => {
        const el = document.getElementById(id);
        el.style.display = 'none';
    });
    const target = document.getElementById(screen);
    target.style.display = screen === 'app-screen' ? 'block' : 'flex';
}

// --- App init (after login) ---
async function initApp() {
    document.getElementById('classDate').value = new Date().toISOString().split('T')[0];
    const isoWeek = getISOWeekString(new Date());
    document.getElementById('filterWeek').value  = isoWeek;
    document.getElementById('summaryWeek').value = isoWeek;

    const [students, att] = await Promise.all([loadStudents(), loadAttendance()]);
    studentsData = students;
    attendance   = att;

    initSearch();

    document.getElementById('newStudentName').addEventListener('keydown', e => {
        if (e.key === 'Enter') addStudent();
    });
    document.getElementById('rechargeAmount').addEventListener('keydown', e => {
        if (e.key === 'Enter') confirmRecharge();
    });
    document.getElementById('debtPayAmount').addEventListener('keydown', e => {
        if (e.key === 'Enter') confirmPayDebt();
    });
    document.getElementById('classDate').addEventListener('change', renderDayAttendance);

    ['rechargeModal', 'debtModal'].forEach(id => {
        document.getElementById(id).addEventListener('click', e => {
            if (e.target === document.getElementById(id)) closeModal(id);
        });
    });

    renderAll();
    showScreen('app-screen');
}

// --- Auth state listener ---
onAuthStateChanged(auth, async (user) => {
    if (user) {
        await initApp();
    } else {
        showScreen('login-screen');
    }
});

document.getElementById('loginPassword').addEventListener('keydown', e => {
    if (e.key === 'Enter') login();
});

// Exponer funciones para los onclick del HTML
Object.assign(window, {
    login, logout,
    addAttendance, removeAttendance,
    addStudent, toggleStudentStatus, deleteStudent,
    openRechargeModal, closeModal, confirmRecharge,
    openDebtModal, confirmPayDebt,
    switchTab,
    renderAttendanceHistory, renderWeeklySummary,
    closeAlert, closeConfirm, closePrompt,
});
