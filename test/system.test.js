const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'busops-system-'));
process.env.DB_FILE = path.join(testRoot, 'db.json');
process.env.UPLOAD_DIR = path.join(testRoot, 'uploads');

const { server } = require('../server');

function cookieFrom(response) {
  return String(response.headers.get('set-cookie') || '').split(';')[0];
}

async function request(baseUrl, pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const contentType = response.headers.get('content-type') || '';
  const value = contentType.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { response, value };
}

async function expectStatus(baseUrl, status, pathname, options) {
  const result = await request(baseUrl, pathname, options);
  assert.equal(result.response.status, status, `${options?.method || 'GET'} ${pathname}: ${JSON.stringify(result.value)}`);
  return result;
}

test('complete booking, check-in, baggage, expense and cash workflow', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await expectStatus(baseUrl, 401, '/api/bootstrap');
    const malformed = await fetch(`${baseUrl}/api/login`, { method:'POST',headers:{'Content-Type':'application/json'},body:'{' });
    assert.equal(malformed.status, 400);
    await expectStatus(baseUrl, 401, '/api/login', { method: 'POST', body: { email: 'admin@albaturist.dk', password: 'forkert' } });

    const adminLogin = await expectStatus(baseUrl, 200, '/api/login', { method: 'POST', body: { email: 'admin@albaturist.dk', password: 'admin123' } });
    const admin = cookieFrom(adminLogin.response);
    const driverLogin = await expectStatus(baseUrl, 200, '/api/login', { method: 'POST', body: { email: 'mads@albaturist.dk', password: 'chauffor123' } });
    const driver = cookieFrom(driverLogin.response);
    const secondaryLogin = await expectStatus(baseUrl, 200, '/api/login', { method: 'POST', body: { email: 'sara@albaturist.dk', password: 'chauffor123' } });
    const secondaryDriver = cookieFrom(secondaryLogin.response);

    const empty = await expectStatus(baseUrl, 200, '/api/bootstrap', { cookie: admin });
    assert.deepEqual(empty.value.stops, []);
    assert.deepEqual(empty.value.buses, []);
    assert.deepEqual(empty.value.trips, []);
    const profileImageData = `data:image/png;base64,${Buffer.from('busops-profile-image').toString('base64')}`;
    await expectStatus(baseUrl, 403, '/api/branding', { method: 'PATCH', cookie: driver, body: { logoName: 'logo.png', logoType: 'image/png', logoData: profileImageData } });
    const branding = (await expectStatus(baseUrl, 200, '/api/branding', { method: 'PATCH', cookie: admin, body: { logoName: 'logo.png', logoType: 'image/png', logoData: profileImageData } })).value;
    assert.equal(branding.hasLogo, true);
    const logo = await expectStatus(baseUrl, 200, '/api/branding/logo');
    assert.equal(logo.response.headers.get('content-type'), 'image/png');

    const origin = (await expectStatus(baseUrl, 201, '/api/stops', { method: 'POST', cookie: admin, body: { name: 'København', address: 'Ingerslevsgade' } })).value;
    const destination = (await expectStatus(baseUrl, 201, '/api/stops', { method: 'POST', cookie: admin, body: { name: 'Tetovo', address: 'Busstationen' } })).value;
    const extraStop = (await expectStatus(baseUrl, 201, '/api/stops', { method: 'POST', cookie: admin, body: { name: 'Odense', address: 'Parkering' } })).value;
    await expectStatus(baseUrl, 403, '/api/stops', { method: 'POST', cookie: driver, body: { name: 'Ikke tilladt' } });

    const standardBus = (await expectStatus(baseUrl, 201, '/api/buses', { method: 'POST', cookie: admin, body: { name: 'Almindelig 54', registration: 'AB 12345', type: 'standard', seatCount: 54 } })).value;
    assert.equal(standardBus.seatCount, 54);
    const doubleBus = (await expectStatus(baseUrl, 201, '/api/buses', { method: 'POST', cookie: admin, body: { name: 'Dobbeltdækker 84', registration: 'CD 67890', type: 'double', seatCount: 12 } })).value;
    assert.equal(doubleBus.seatCount, 84);
    assert.equal(doubleBus.lowerDeckSeats, 22);
    await expectStatus(baseUrl, 400, '/api/buses', { method: 'POST', cookie: admin, body: { name: 'For stor', registration: 'EF 11111', type: 'standard', seatCount: 55 } });
    await expectStatus(baseUrl, 403, '/api/buses', { method: 'POST', cookie: driver, body: { name: 'Ikke tilladt', registration: 'XX 00000', type: 'standard', seatCount: 10 } });

    const spareDriver = (await expectStatus(baseUrl, 201, '/api/drivers', { method: 'POST', cookie: admin, body: { name: 'Test Chauffør', email: 'testdriver@albaturist.dk', password: 'testpass1234', portraitName: 'chauffor.png', portraitType: 'image/png', portraitData: profileImageData } })).value;
    assert.equal(spareDriver.hasPortrait, true);
    const portrait = await expectStatus(baseUrl, 200, `/api/drivers/${spareDriver.id}/portrait`, { cookie: admin });
    assert.equal(portrait.response.headers.get('content-type'), 'image/png');
    const salesManager = (await expectStatus(baseUrl, 201, '/api/sales-managers', { method: 'POST', cookie: admin, body: { name: 'Test Salgschef', email: 'testsalg@albaturist.dk', password: 'testpass1234', salesOfficeName: 'København-kontoret', salesOfficeCountry: 'DK' } })).value;
    const otherSalesManager = (await expectStatus(baseUrl, 201, '/api/sales-managers', { method: 'POST', cookie: admin, body: { name: 'Anden Salgschef', email: 'andensalg@albaturist.dk', password: 'andenpass1234', salesOfficeName: 'Berlin-kontoret', salesOfficeCountry: 'DE' } })).value;
    const salesLogin = await expectStatus(baseUrl, 200, '/api/login', { method: 'POST', body: { email: 'testsalg@albaturist.dk', password: 'testpass1234' } });
    const sales = cookieFrom(salesLogin.response);
    const otherSalesLogin = await expectStatus(baseUrl, 200, '/api/login', { method: 'POST', body: { email: 'andensalg@albaturist.dk', password: 'andenpass1234' } });
    const otherSales = cookieFrom(otherSalesLogin.response);
    const spareLogin = await expectStatus(baseUrl, 200, '/api/login', { method: 'POST', body: { email: 'testdriver@albaturist.dk', password: 'testpass1234' } });
    const spare = cookieFrom(spareLogin.response);
    const salesBootstrap = (await expectStatus(baseUrl, 200, '/api/bootstrap', { cookie: sales })).value;
    assert.equal(salesBootstrap.buses.length, 2);
    assert.ok(salesBootstrap.drivers.some(candidate => candidate.id === 2));
    assert.equal(salesBootstrap.user.salesOfficeName, 'København-kontoret');
    assert.equal(salesBootstrap.user.salesOfficeCountry, 'DK');
    assert.equal((await expectStatus(baseUrl, 200, '/api/profile/language', { method: 'PATCH', cookie: admin, body: { language: 'en' } })).value.language, 'en');
    assert.equal((await expectStatus(baseUrl, 200, '/api/profile/language', { method: 'PATCH', cookie: driver, body: { language: 'sq' } })).value.language, 'sq');
    assert.equal((await expectStatus(baseUrl, 200, '/api/profile/language', { method: 'PATCH', cookie: sales, body: { language: 'de' } })).value.language, 'de');
    assert.equal((await expectStatus(baseUrl, 200, '/api/profile/language', { method: 'PATCH', cookie: spare, body: { language: 'da' } })).value.language, 'da');
    await expectStatus(baseUrl, 400, '/api/profile/language', { method: 'PATCH', cookie: driver, body: { language: 'fr' } });
    const languageBootstrap = (await expectStatus(baseUrl, 200, '/api/bootstrap', { cookie: driver })).value;
    assert.equal(languageBootstrap.user.language, 'sq');
    await expectStatus(baseUrl, 403, `/api/drivers/${spareDriver.id}`, { method:'PATCH',cookie:admin,body:{name:spareDriver.name,email:'changed-by-admin@albaturist.dk',password:'admin-changed-password'} });
    await expectStatus(baseUrl, 401, '/api/profile', { method:'PATCH',cookie:spare,body:{email:'minchauffor@albaturist.dk',currentPassword:'forkert',newPassword:''} });
    const ownDriverProfile=(await expectStatus(baseUrl,200,'/api/profile',{method:'PATCH',cookie:spare,body:{email:'minchauffor@albaturist.dk',currentPassword:'testpass1234',newPassword:'chaufforens-nye-kode'}})).value;
    assert.equal(ownDriverProfile.user.email,'minchauffor@albaturist.dk');
    await expectStatus(baseUrl,401,'/api/login',{method:'POST',body:{email:'testdriver@albaturist.dk',password:'testpass1234'}});
    await expectStatus(baseUrl,200,'/api/login',{method:'POST',body:{email:'minchauffor@albaturist.dk',password:'chaufforens-nye-kode'}});
    await expectStatus(baseUrl,403,`/api/sales-managers/${salesManager.id}`,{method:'PATCH',cookie:admin,body:{name:salesManager.name,email:'changed-by-admin-sales@albaturist.dk'}});

    const validDepartureAt = new Date(Date.now() + 86400000);
    const validDestinationArrivalAt = new Date(validDepartureAt.getTime() + 720 * 60000);
    await expectStatus(baseUrl, 400, '/api/trips', {
      method: 'POST', cookie: admin, body: {
        title: 'Ugyldigt startsted',
        departureAt: validDepartureAt.toISOString(),
        destinationArrivalAt: validDestinationArrivalAt.toISOString(),
        originId: extraStop.id,
        destinationId: destination.id,
        busId: doubleBus.id,
        primaryDriverId: 2
      }
    });
    await expectStatus(baseUrl, 400, '/api/trips', { method: 'POST', cookie: admin, body: { title: 'Ugyldig destination', departureAt: validDepartureAt.toISOString(), destinationArrivalAt: validDestinationArrivalAt.toISOString(), originId: origin.id, destinationId: 999999, busId: doubleBus.id, primaryDriverId: 2 } });
    await expectStatus(baseUrl, 400, '/api/trips', { method: 'POST', cookie: admin, body: { title: 'Ugyldig chauffør', departureAt: validDepartureAt.toISOString(), destinationArrivalAt: validDestinationArrivalAt.toISOString(), originId: origin.id, destinationId: destination.id, busId: doubleBus.id, primaryDriverId: 999999 } });
    await expectStatus(baseUrl, 400, '/api/trips', { method: 'POST', cookie: admin, body: { title: 'Ugyldig dato', departureAt: 'ikke-en-dato', destinationArrivalAt: validDestinationArrivalAt.toISOString(), originId: origin.id, destinationId: destination.id, busId: doubleBus.id, primaryDriverId: 2 } });
    await expectStatus(baseUrl, 400, '/api/trips', { method: 'POST', cookie: admin, body: { title: 'Manglende ankomst', departureAt: validDepartureAt.toISOString(), originId: origin.id, destinationId: destination.id, busId: doubleBus.id, primaryDriverId: 2 } });
    await expectStatus(baseUrl, 400, '/api/trips', { method: 'POST', cookie: admin, body: { title: 'Ankomst før afgang', departureAt: validDepartureAt.toISOString(), destinationArrivalAt: new Date(validDepartureAt.getTime() - 60000).toISOString(), originId: origin.id, destinationId: destination.id, busId: doubleBus.id, primaryDriverId: 2 } });
    await expectStatus(baseUrl, 403, '/api/trips', { method: 'POST', cookie: driver, body: { title: 'Chauffør må ikke oprette', departureAt: validDepartureAt.toISOString(), destinationArrivalAt: validDestinationArrivalAt.toISOString(), originId: origin.id, destinationId: destination.id, busId: doubleBus.id, primaryDriverId: 2 } });

    const trip = (await expectStatus(baseUrl, 201, '/api/trips', {
      method: 'POST', cookie: sales, body: {
        title: 'Systemtest København–Tetovo',
        departureAt: validDepartureAt.toISOString(),
        destinationArrivalAt: validDestinationArrivalAt.toISOString(),
        originId: origin.id,
        destinationId: destination.id,
        basePrice: 400,
        busId: doubleBus.id,
        primaryDriverId: 2,
        secondaryDriverId: 3,
        salesManagerId: 999999
      }
    })).value;
    assert.equal(trip.salesManagerId, null);
    assert.equal(trip.seatCount, 84);
    assert.equal(trip.durationMinutes, 720);
    assert.equal(trip.destinationArrivalAt, validDestinationArrivalAt.toISOString());
    assert.equal(trip.timetable.length, 2);
    assert.equal(trip.timetable[0].stopId, origin.id);
    assert.equal(trip.timetable[1].stopId, destination.id);
    const timetableStart = new Date(trip.departureAt);
    const timetable = [
      { stopId: origin.id, arrivalAt: timetableStart.toISOString(), departureAt: new Date(timetableStart.getTime() + 15 * 60000).toISOString() },
      { stopId: extraStop.id, arrivalAt: new Date(timetableStart.getTime() + 120 * 60000).toISOString(), departureAt: new Date(timetableStart.getTime() + 135 * 60000).toISOString() },
      { stopId: destination.id, arrivalAt: new Date(timetableStart.getTime() + 720 * 60000).toISOString(), departureAt: new Date(timetableStart.getTime() + 720 * 60000).toISOString() }
    ];
    await expectStatus(baseUrl, 403, `/api/trips/${trip.id}`, { method: 'PATCH', cookie: driver, body: { timetable } });
    await expectStatus(baseUrl, 400, `/api/trips/${trip.id}`, { method: 'PATCH', cookie: admin, body: { timetable: timetable.map((row,index) => index===1 ? { ...row, departureAt: new Date(timetableStart.getTime() + 60 * 60000).toISOString() } : row) } });
    const scheduledTrip = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}`, { method: 'PATCH', cookie: admin, body: { timetable } })).value;
    assert.equal(scheduledTrip.timetable.length, 3);
    assert.equal(scheduledTrip.timetable[1].stopId, extraStop.id);
    assert.equal(scheduledTrip.timetable[1].arrivalAt, timetable[1].arrivalAt);
    assert.equal(scheduledTrip.destinationArrivalAt, timetable[2].arrivalAt);
    assert.equal(scheduledTrip.timetable[2].departureAt, timetable[2].arrivalAt);
    const otherSalesTrips=(await expectStatus(baseUrl,200,'/api/bootstrap',{cookie:otherSales})).value.trips;
    assert.ok(otherSalesTrips.some(candidate=>candidate.id===trip.id));
    const assignedSalesManager=(await expectStatus(baseUrl,200,`/api/trips/${trip.id}`,{method:'PATCH',cookie:admin,body:{salesManagerId:salesManager.id}})).value;
    assert.equal(assignedSalesManager.salesManagerOnDutyId,salesManager.id);
    assert.equal(assignedSalesManager.salesManagerOnDuty,'Test Salgschef');
    await expectStatus(baseUrl, 409, `/api/stops/${extraStop.id}`, { method: 'DELETE', cookie: admin });

    await expectStatus(baseUrl, 403, `/api/trips/${trip.id}`, { method: 'PATCH', cookie: sales, body: { departureChecklistItem: 'vehicle_ready', checked: true } });
    const vehicleChecked = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}`, { method: 'PATCH', cookie: driver, body: { departureChecklistItem: 'vehicle_ready', checked: true } })).value;
    assert.equal(vehicleChecked.departureChecklist.vehicle_ready.checkedBy, 2);
    assert.equal(vehicleChecked.departureChecklist.vehicle_ready.checkedByName, 'Mads Chauffør');
    const passengerListChecked = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}`, { method: 'PATCH', cookie: sales, body: { departureChecklistItem: 'passenger_list', checked: true } })).value;
    assert.equal(passengerListChecked.departureChecklist.passenger_list.checkedBy, salesManager.id);
    const vehicleReopened = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}`, { method: 'PATCH', cookie: driver, body: { departureChecklistItem: 'vehicle_ready', checked: false } })).value;
    assert.equal(vehicleReopened.departureChecklist.vehicle_ready, null);
    await expectStatus(baseUrl, 400, `/api/trips/${trip.id}`, { method: 'PATCH', cookie: admin, body: { departureChecklistItem: 'ukendt', checked: true } });

    const returnDepartureAt = new Date(validDepartureAt.getTime() + 3 * 86400000);
    const returnTrip = (await expectStatus(baseUrl, 201, '/api/trips', {
      method: 'POST', cookie: admin, body: {
        title: 'Systemtest Tetovo–København retur',
        departureAt: returnDepartureAt.toISOString(),
        destinationArrivalAt: new Date(returnDepartureAt.getTime() + 720 * 60000).toISOString(),
        originId: destination.id,
        destinationId: origin.id,
        busId: doubleBus.id,
        primaryDriverId: 2,
        secondaryDriverId: 3,
        salesManagerId: salesManager.id
      }
    })).value;

    const emptyTrip = (await expectStatus(baseUrl, 201, '/api/trips', {
      method: 'POST', cookie: admin, body: {
        title: 'Tom tur til sletning',
        departureAt: new Date(Date.now() + 172800000).toISOString(),
        destinationArrivalAt: new Date(Date.now() + 172800000 + 720 * 60000).toISOString(),
        originId: origin.id,
        destinationId: destination.id,
        busId: doubleBus.id,
        primaryDriverId: 2
      }
    })).value;
    assert.equal(emptyTrip.basePrice, 0);
    await expectStatus(baseUrl, 403, `/api/trips/${emptyTrip.id}`, { method: 'DELETE', cookie: driver });
    await expectStatus(baseUrl, 200, `/api/trips/${emptyTrip.id}`, { method: 'DELETE', cookie: admin });
    await expectStatus(baseUrl, 404, `/api/trips/${emptyTrip.id}`, { cookie: admin });

    await expectStatus(baseUrl, 200, `/api/trips/${trip.id}`, { cookie: driver });
    await expectStatus(baseUrl, 200, `/api/trips/${trip.id}`, { cookie: sales });
    await expectStatus(baseUrl, 403, `/api/trips/${trip.id}`, { cookie: spare });
    await expectStatus(baseUrl, 403, '/api/reports', { cookie: driver });
    await expectStatus(baseUrl, 403, '/api/reports', { cookie: sales });

    const seats = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/seats`, { cookie: admin })).value;
    assert.equal(seats.length, 84);
    assert.equal(seats.filter(seat => seat.deck === 'lower').length, 22);
    assert.equal(seats.filter(seat => seat.deck === 'upper').length, 62);
    assert.equal(seats.filter(seat => seat.type === 'table').length, 8);
    assert.deepEqual(seats.filter(seat => seat.type === 'table').map(seat => seat.number), [1,2,3,4,5,6,7,8]);
    assert.equal(seats.filter(seat => seat.type === 'front').length, 4);
    assert.equal(seats.find(seat => seat.number === 1).surcharge, 75);
    assert.equal(seats.find(seat => seat.number === 5).surcharge, 75);
    assert.equal(seats.find(seat => seat.number === 23).surcharge, 100);

    const fixedReturn = (await expectStatus(baseUrl, 201, `/api/trips/${trip.id}/passengers`, { method: 'POST', cookie: admin, body: { name: 'Fast returpassager', phone: '10101010', pickupStopId: origin.id, destinationStopId: destination.id, paymentStatus: 'cash', paymentCurrency: 'DKK', cashAmount: 900, seatNumber: 80, ticketType: 'return_fixed', returnTripId: returnTrip.id, returnSeatNumber: 12 } })).value;
    assert.equal(fixedReturn.ticketType, 'return_fixed');
    assert.equal(fixedReturn.returnStatus, 'booked');
    assert.equal(fixedReturn.returnPassenger.tripId, returnTrip.id);
    assert.equal(fixedReturn.returnPassenger.seatNumber, 12);
    assert.equal(fixedReturn.returnPassenger.paymentStatus, 'return_included');
    assert.match(fixedReturn.bookingNumber,/^ALB-\d{4}-\d{6}$/);
    assert.equal(fixedReturn.returnPassenger.bookingNumber,fixedReturn.bookingNumber);
    const fixedReturnPdf=await expectStatus(baseUrl,200,`/api/bookings/${encodeURIComponent(fixedReturn.bookingNumber)}/ticket.pdf?download=1&reprint=1`,{cookie:admin});
    assert.equal(fixedReturnPdf.response.headers.get('content-type'),'application/pdf');
    assert.match(fixedReturnPdf.response.headers.get('content-disposition')||'',/attachment/);
    assert.equal(fixedReturnPdf.value.subarray(0,8).toString(),'%PDF-1.4');
    assert.ok(fixedReturnPdf.value.length>9000);
    const digitalTicketUrl=(fixedReturnPdf.response.headers.get('link')||'').match(/<([^>]+)>/)?.[1];
    assert.ok(digitalTicketUrl);
    const digitalTicketPath=new URL(digitalTicketUrl).pathname,digitalTicket=await expectStatus(baseUrl,200,digitalTicketPath);
    assert.match(digitalTicket.value.toString(),/Scan ved check-in/);
    const fixedReturnToken=decodeURIComponent(digitalTicketPath.split('/').at(-1));
    const scannedBooking=(await expectStatus(baseUrl,200,`/api/trips/${trip.id}/ticket-scan`,{method:'POST',cookie:driver,body:{token:fixedReturnToken}})).value;
    assert.equal(scannedBooking.bookingNumber,fixedReturn.bookingNumber);
    assert.equal(scannedBooking.passengers[0].id,fixedReturn.id);
    const salesScannedBooking=(await expectStatus(baseUrl,200,`/api/trips/${trip.id}/ticket-scan`,{method:'POST',cookie:sales,body:{token:fixedReturnToken}})).value;
    assert.equal(salesScannedBooking.bookingNumber,fixedReturn.bookingNumber);
    await expectStatus(baseUrl,403,`/api/trips/${trip.id}/ticket-scan`,{method:'POST',cookie:otherSales,body:{token:fixedReturnToken}});
    await expectStatus(baseUrl,403,`/api/trips/${trip.id}/ticket-scan`,{method:'POST',cookie:admin,body:{token:fixedReturnToken}});
    await expectStatus(baseUrl,403,`/api/bookings/${encodeURIComponent(fixedReturn.bookingNumber)}/ticket.pdf`,{cookie:spare});
    const duplicateWarning=await expectStatus(baseUrl,409,`/api/trips/${trip.id}/passengers`,{method:'POST',cookie:admin,body:{name:'Fast returpassager',phone:'10101010',pickupStopId:origin.id,destinationStopId:destination.id,paymentStatus:'unpaid',seatNumber:79}});
    assert.equal(duplicateWarning.value.duplicateWarning,true);
    assert.equal(duplicateWarning.value.duplicates[0].bookingNumber,fixedReturn.bookingNumber);
    const confirmedDuplicate=(await expectStatus(baseUrl,201,`/api/trips/${trip.id}/passengers`,{method:'POST',cookie:admin,body:{name:'Fast returpassager',phone:'10101010',pickupStopId:origin.id,destinationStopId:destination.id,paymentStatus:'unpaid',seatNumber:79,confirmDuplicate:true}})).value;
    assert.notEqual(confirmedDuplicate.bookingNumber,fixedReturn.bookingNumber);
    const duplicatePdf=await expectStatus(baseUrl,200,`/api/bookings/${encodeURIComponent(confirmedDuplicate.bookingNumber)}/ticket.pdf`,{cookie:admin}),duplicateTicketUrl=(duplicatePdf.response.headers.get('link')||'').match(/<([^>]+)>/)?.[1],duplicateToken=decodeURIComponent(new URL(duplicateTicketUrl).pathname.split('/').at(-1));
    const qrCheckedIn=(await expectStatus(baseUrl,200,`/api/trips/${trip.id}/ticket-scan`,{method:'POST',cookie:driver,body:{token:duplicateToken,passengerId:confirmedDuplicate.id}})).value;
    assert.equal(qrCheckedIn.passenger.checkedIn,true);
    assert.equal(qrCheckedIn.passenger.attendanceHistory.at(-1).source,'qr_scan');
    await expectStatus(baseUrl,200,`/api/trips/${trip.id}/passengers`,{method:'PATCH',cookie:driver,body:{id:confirmedDuplicate.id,checkedIn:false}});
    await expectStatus(baseUrl,200,`/api/trips/${trip.id}/passengers`,{method:'DELETE',cookie:admin,body:{id:confirmedDuplicate.id,deletionReason:'Fjerner bekræftet dublettest'}});
    assert.equal((await expectStatus(baseUrl, 200, `/api/trips/${returnTrip.id}/seats`, { cookie: admin })).value.find(seat => seat.number === 12).passengerId, fixedReturn.returnPassenger.id);
    await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/passengers`, { method: 'DELETE', cookie: admin, body: { id: fixedReturn.id, deletionReason: 'Fjerner test af fast retur' } });
    assert.equal((await expectStatus(baseUrl, 200, `/api/trips/${returnTrip.id}/seats`, { cookie: admin })).value.find(seat => seat.number === 12).passengerId, null);

    const openReturn = (await expectStatus(baseUrl, 201, `/api/trips/${trip.id}/passengers`, { method: 'POST', cookie: admin, body: { name: 'Åben returpassager', phone: '10101012', pickupStopId: origin.id, destinationStopId: destination.id, paymentStatus: 'pay_dk', seatNumber: 80, ticketType: 'return_open', openReturnValidUntil: '2099-12-31' } })).value;
    assert.equal(openReturn.ticketType, 'return_open');
    assert.equal(openReturn.returnStatus, 'open');
    const bookedOpenReturn = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/passengers`, { method: 'PATCH', cookie: admin, body: { id: openReturn.id, bookOpenReturn: true, returnTripId: returnTrip.id, returnSeatNumber: 13 } })).value;
    assert.equal(bookedOpenReturn.ticketType, 'return_fixed');
    assert.equal(bookedOpenReturn.returnPassenger.seatNumber, 13);
    await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/passengers`, { method: 'DELETE', cookie: admin, body: { id: openReturn.id, deletionReason: 'Fjerner test af åben retur' } });

    const partyBooking = (await expectStatus(baseUrl, 201, `/api/trips/${trip.id}/group-bookings`, { method: 'POST', cookie: admin, body: {
      phone: '40404040', pickupStopId: origin.id, destinationStopId: destination.id, paymentStatus: 'pay_dk', paymentCurrency: 'DKK', ticketType: 'return_fixed', returnTripId: returnTrip.id,
      passengers: [
        { name: 'Familie Hovedperson', ticketNumber: 'FAM-001', seatNumber: 70, returnSeatNumber: 14 },
        { name: 'Familie Medlem 1', ticketNumber: 'FAM-002', seatNumber: 71, returnSeatNumber: 15 },
        { name: 'Familie Medlem 2', ticketNumber: 'FAM-003', seatNumber: 72, returnSeatNumber: 16 }
      ]
    } })).value;
    assert.equal(partyBooking.partySize, 3);
    assert.equal(partyBooking.passengers[0].partyRole, 'primary');
    assert.equal(partyBooking.passengers[0].phone, '40404040');
    assert.equal(partyBooking.passengers[1].partyRole, 'member');
    assert.equal(partyBooking.passengers[1].phone, '');
    assert.match(partyBooking.passengers[0].bookingNumber,/^ALB-\d{4}-\d{6}$/);
    assert.ok(partyBooking.passengers.every(passenger=>passenger.bookingNumber===partyBooking.passengers[0].bookingNumber));
    assert.equal(partyBooking.passengers[1].partyContactPhone, '40404040');
    assert.equal(partyBooking.passengers[1].paymentStatus, 'group_included');
    const notificationView=(await expectStatus(baseUrl,200,`/api/trips/${trip.id}`,{cookie:admin})).value;
    const groupNotification=notificationView.notifications.find(item=>item.phone==='40404040'&&item.type==='booking_confirmation');
    assert.ok(groupNotification.body.includes('3 passagerer'));
    assert.equal((await expectStatus(baseUrl,200,`/api/trips/${trip.id}`,{cookie:driver})).value.notifications.length,0);
    const archivedNotification=(await expectStatus(baseUrl,200,`/api/trips/${trip.id}/notifications`,{method:'PATCH',cookie:admin,body:{id:groupNotification.id,status:'archived'}})).value;
    assert.equal(archivedNotification.status,'archived');
    const partyMember = partyBooking.passengers[1];
    await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/passengers`, { method: 'PATCH', cookie: admin, body: { id: partyMember.id, checkedIn: true } });
    await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/passengers`, { method: 'DELETE', cookie: admin, body: { id: partyMember.id, deletionReason: 'Fjerner et familiemedlem' } });
    let partyRecords = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}`, { cookie: admin })).value.passengers.filter(passenger => passenger.partyBookingId === partyBooking.partyBookingId);
    assert.equal(partyRecords.length, 2);
    assert.ok(partyRecords.every(passenger => passenger.partySize === 2));
    await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/passengers`, { method: 'DELETE', cookie: admin, body: { id: partyBooking.partyPrimaryPassengerId, deletionReason: 'Skifter gruppens hovedperson' } });
    partyRecords = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}`, { cookie: admin })).value.passengers.filter(passenger => passenger.partyBookingId === partyBooking.partyBookingId);
    assert.equal(partyRecords.length, 1);
    assert.equal(partyRecords[0].partyRole, 'primary');
    assert.equal(partyRecords[0].phone, '40404040');
    assert.equal(partyRecords[0].paymentStatus, 'pay_dk');
    await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/passengers`, { method: 'DELETE', cookie: admin, body: { id: partyRecords[0].id, deletionReason: 'Fjerner sidste gruppemedlem' } });

    const unpaidPassenger = (await expectStatus(baseUrl, 201, `/api/trips/${trip.id}/passengers`, { method: 'POST', cookie: admin, body: { name: 'Betaler i Danmark', ticketNumber: 'TEST-001', phone: '11111111', pickupStopId: extraStop.id, destinationStopId: destination.id, paymentStatus: 'pay_dk', seatNumber: 23 } })).value;
    const offlineCreate={name:'Offline idempotent',phone:'11111113',pickupStopId:origin.id,destinationStopId:destination.id,paymentStatus:'unpaid',seatNumber:24,clientActionId:'offline-create-test-1'};
    const offlineCreated=(await expectStatus(baseUrl,201,`/api/trips/${trip.id}/passengers`,{method:'POST',cookie:admin,body:offlineCreate})).value;
    const offlineReplayed=(await expectStatus(baseUrl,201,`/api/trips/${trip.id}/passengers`,{method:'POST',cookie:admin,body:offlineCreate})).value;
    assert.equal(offlineReplayed.id,offlineCreated.id);
    assert.equal((await expectStatus(baseUrl,200,`/api/trips/${trip.id}`,{cookie:admin})).value.passengers.filter(item=>item.name==='Offline idempotent').length,1);
    const offlineChecked=(await expectStatus(baseUrl,200,`/api/trips/${trip.id}/passengers`,{method:'PATCH',cookie:admin,body:{id:offlineCreated.id,checkedIn:true,clientActionId:'offline-check-test-1'}})).value;
    const offlineCheckReplay=(await expectStatus(baseUrl,200,`/api/trips/${trip.id}/passengers`,{method:'PATCH',cookie:admin,body:{id:offlineCreated.id,checkedIn:true,clientActionId:'offline-check-test-1'}})).value;
    assert.equal(offlineCheckReplay.attendanceHistory.length,offlineChecked.attendanceHistory.length);
    await expectStatus(baseUrl,200,`/api/trips/${trip.id}/passengers`,{method:'DELETE',cookie:admin,body:{id:offlineCreated.id,deletionReason:'Fjerner offline-idempotens-test'}});
    await expectStatus(baseUrl,200,'/api/offline/status',{method:'POST',cookie:driver,body:{deviceId:'test-driver-device',pendingCount:2,conflictCount:1,label:'Testtelefon'}});
    const dashboardWithOfflineAlert=(await expectStatus(baseUrl,200,'/api/dashboard',{cookie:admin})).value;
    assert.ok(dashboardWithOfflineAlert.operationalAlerts.some(alert=>alert.id==='offline-actions'&&alert.severity==='critical'));
    await expectStatus(baseUrl,200,'/api/offline/status',{method:'POST',cookie:driver,body:{deviceId:'test-driver-device',pendingCount:0,conflictCount:0,label:'Testtelefon'}});
    await expectStatus(baseUrl, 400, `/api/trips/${trip.id}/passengers`, { method: 'POST', cookie: admin, body: { name: 'Ukendt stoppested', phone: '11111112', pickupStopId: 999999, destinationStopId: destination.id, paymentStatus: 'unpaid', seatNumber: 24 } });
    assert.equal(unpaidPassenger.paymentStatus, 'pay_dk');
    assert.equal(unpaidPassenger.ticketNumber, 'TEST-001');
    const externalPaymentPassenger = (await expectStatus(baseUrl, 201, `/api/trips/${trip.id}/passengers`, { method: 'POST', cookie: admin, body: { name: 'Kontorbetaling DK', phone: '11111119', pickupStopId: origin.id, destinationStopId: destination.id, paymentStatus: 'pay_dk', seatNumber: 84 } })).value;
    await expectStatus(baseUrl, 403, `/api/trips/${trip.id}/passengers`, { method: 'PATCH', cookie: driver, body: { id: externalPaymentPassenger.id, confirmExternalPayment: true, amount: 450, currency: 'DKK' } });
    const confirmedExternalPassenger = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/passengers`, { method: 'PATCH', cookie: sales, body: { id: externalPaymentPassenger.id, confirmExternalPayment: true, amount: 450, currency: 'DKK', note: 'Betalt i København butik' } })).value;
    assert.equal(confirmedExternalPassenger.paymentStatus, 'pay_dk');
    assert.equal(confirmedExternalPassenger.externalPaymentAmount, 450);
    assert.equal(confirmedExternalPassenger.externalPaymentConfirmedBy, salesManager.id);
    assert.equal(confirmedExternalPassenger.cashHolderUserId, null);
    await expectStatus(baseUrl, 409, `/api/trips/${trip.id}/passengers`, { method: 'PATCH', cookie: sales, body: { id: externalPaymentPassenger.id, confirmExternalPayment: true, amount: 450, currency: 'DKK' } });
    const externalTripView = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}`, { cookie: admin })).value;
    assert.equal(externalTripView.passengers.find(item => item.id === externalPaymentPassenger.id).externalPaymentConfirmedByName, 'Test Salgschef');
    await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/passengers`, { method: 'DELETE', cookie: admin, body: { id: externalPaymentPassenger.id, deletionReason: 'Fjerner betalingsbekræftelsestesten igen' } });
    await expectStatus(baseUrl, 409, `/api/trips/${trip.id}/passengers`, { method: 'POST', cookie: admin, body: { name: 'Dublet billetnummer', ticketNumber: 'test-001', phone: '10101011', pickupStopId: origin.id, destinationStopId: destination.id, paymentStatus: 'unpaid', seatNumber: 24 } });
    await expectStatus(baseUrl, 201, `/api/trips/${trip.id}/passengers`, { method: 'POST', cookie: admin, body: { name: 'Euro Passager', phone: '22222222', pickupStopId: origin.id, destinationStopId: destination.id, paymentStatus: 'cash', paymentCurrency: 'EUR', cashAmount: 25, seatNumber: 1 } });
    await expectStatus(baseUrl, 201, `/api/trips/${trip.id}/passengers`, { method: 'POST', cookie: admin, body: { name: 'Gratis Passager', phone: '33333333', pickupStopId: origin.id, destinationStopId: destination.id, paymentStatus: 'free', freeTicketReason: 'Test', seatNumber: 2 } });
    await expectStatus(baseUrl, 409, `/api/trips/${trip.id}/passengers`, { method: 'POST', cookie: admin, body: { name: 'Dublet', phone: '44444444', pickupStopId: origin.id, destinationStopId: destination.id, paymentStatus: 'unpaid', seatNumber: 1 } });
    await expectStatus(baseUrl, 403, `/api/trips/${trip.id}/passengers`, { method: 'POST', cookie: driver, body: { name: 'Ikke tilladt', phone: '55555555', pickupStopId: origin.id, destinationStopId: destination.id, paymentStatus: 'unpaid', seatNumber: 3 } });
    const intermediateStopSale = (await expectStatus(baseUrl, 201, `/api/trips/${trip.id}/passengers`, { method: 'POST', cookie: otherSales, body: { name: 'Opsamling undervejs', phone: '55555555', pickupStopId: extraStop.id, destinationStopId: destination.id, paymentStatus: 'cash', paymentCurrency: 'EUR', cashAmount: 45, seatNumber: 3 } })).value;
    assert.equal(intermediateStopSale.pickupStopId, extraStop.id);
    assert.equal(intermediateStopSale.paymentLocation, 'shop');
    assert.equal(intermediateStopSale.cashHolderUserId, otherSalesManager.id);
    assert.equal(intermediateStopSale.salesOfficeName, 'Berlin-kontoret');
    assert.equal(intermediateStopSale.salesOfficeCountry, 'DE');
    await expectStatus(baseUrl,403,`/api/trips/${trip.id}/passengers`,{method:'PATCH',cookie:otherSales,body:{id:intermediateStopSale.id,checkedIn:true}});
    await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/passengers`, { method: 'DELETE', cookie: otherSales, body: { id: intermediateStopSale.id, deletionReason: 'Fjerner testregistreringen igen' } });
    await expectStatus(baseUrl, 403, `/api/trips/${trip.id}/passengers`, { method: 'POST', cookie: sales, body: { name: 'Gratis fra salg', phone: '55555555', pickupStopId: origin.id, destinationStopId: destination.id, paymentStatus: 'free', seatNumber: 3 } });
    const adminExtraSeatTicket = (await expectStatus(baseUrl, 201, `/api/trips/${trip.id}/passengers`, { method: 'POST', cookie: admin, body: { name: 'Administrator ekstrasaede', phone: '55555557', pickupStopId: origin.id, destinationStopId: destination.id, paymentStatus: 'cash', paymentCurrency: 'DKK', cashAmount: 90, seatNumber: 9, extraSeatNumber: 10, extraSeatAmount: 50, extraSeatCurrency: 'DKK', extraSeatFree: false } })).value;
    assert.equal(adminExtraSeatTicket.extraSeatNumber, 10);
    await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/passengers`, { method: 'DELETE', cookie: admin, body: { id: adminExtraSeatTicket.id, deletionReason: 'Fjerner administratortesten igen' } });
    const payLaterExtraSeatTicket = (await expectStatus(baseUrl, 201, `/api/trips/${trip.id}/passengers`, { method: 'POST', cookie: admin, body: { name: 'Ekstrasaede betales senere', phone: '55555558', pickupStopId: origin.id, destinationStopId: destination.id, paymentStatus: 'pay_dk', seatNumber: 9, extraSeatNumber: 10, extraSeatAmount: 50, extraSeatCurrency: 'DKK', extraSeatFree: false } })).value;
    assert.equal(payLaterExtraSeatTicket.paymentStatus, 'pay_dk');
    assert.equal(payLaterExtraSeatTicket.extraSeatNumber, 10);
    assert.equal(payLaterExtraSeatTicket.extraSeatAmount, 50);
    assert.equal(payLaterExtraSeatTicket.cashAmount, 0);
    await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/passengers`, { method: 'DELETE', cookie: admin, body: { id: payLaterExtraSeatTicket.id, deletionReason: 'Fjerner betal-senere-testen igen' } });
    const ticketWithoutExtraSeat = (await expectStatus(baseUrl, 201, `/api/trips/${trip.id}/passengers`, { method: 'POST', cookie: sales, body: { name: 'Billet uden ekstrasaede', phone: '55555556', pickupStopId: origin.id, destinationStopId: destination.id, paymentStatus: 'pay_dk', seatNumber: 9 } })).value;
    await expectStatus(baseUrl, 409, `/api/trips/${trip.id}/passengers`, { method: 'PATCH', cookie: sales, body: { id: ticketWithoutExtraSeat.id, edit: true, name: ticketWithoutExtraSeat.name, phone: ticketWithoutExtraSeat.phone, pickupStopId: ticketWithoutExtraSeat.pickupStopId, destinationStopId: ticketWithoutExtraSeat.destinationStopId, seatNumber: 9, extraSeatNumber: 10, extraSeatFree: true, correctionReason: 'Forsoger at tilkoebe ekstrasaede bagefter' } });
    await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/passengers`, { method: 'DELETE', cookie: sales, body: { id: ticketWithoutExtraSeat.id, deletionReason: 'Fjerner testen igen' } });
    await expectStatus(baseUrl, 400, `/api/trips/${trip.id}/passengers`, { method: 'POST', cookie: sales, body: { name: 'Forkert ekstra seat', phone: '66666665', pickupStopId: origin.id, destinationStopId: destination.id, paymentStatus: 'cash', paymentCurrency: 'DKK', cashAmount: 100, seatNumber: 3, extraSeatNumber: 7, extraSeatAmount: 75, extraSeatCurrency: 'DKK', extraSeatFree: false } });
    const salesTicket = (await expectStatus(baseUrl, 201, `/api/trips/${trip.id}/passengers`, { method: 'POST', cookie: sales, body: { name: 'Startsted Passager', phone: '66666666', pickupStopId: origin.id, destinationStopId: destination.id, paymentStatus: 'cash', paymentCurrency: 'DKK', cashAmount: 100, seatNumber: 3, extraSeatNumber: 4, extraSeatAmount: 75, extraSeatCurrency: 'DKK', extraSeatFree: false } })).value;
    assert.equal(salesTicket.ticketCashAmount, 100);
    assert.equal(salesTicket.cashAmount, 175);
    assert.equal(salesTicket.extraSeatNumber, 4);
    assert.equal(salesTicket.extraSeatAmount, 75);
    assert.equal(salesTicket.extraSeatFree, false);
    const seatsWithPaidExtra = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/seats`, { cookie: sales })).value;
    assert.equal(seatsWithPaidExtra.find(seat => seat.number === 4).passengerId, salesTicket.id);
    assert.equal(seatsWithPaidExtra.find(seat => seat.number === 4).reservationType, 'extra');
    await expectStatus(baseUrl, 409, `/api/trips/${trip.id}/passengers`, { method: 'POST', cookie: sales, body: { name: 'Forsøger optaget ekstrasæde', phone: '66666668', pickupStopId: origin.id, destinationStopId: destination.id, paymentStatus: 'cash', paymentCurrency: 'DKK', cashAmount: 100, seatNumber: 4 } });
    const salesCorrectedTicket = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/passengers`, { method: 'PATCH', cookie: sales, body: { id: salesTicket.id, edit: true, name: 'Startsted Passager Rettet', phone: '66666667', pickupStopId: origin.id, destinationStopId: destination.id, seatNumber: 3, cashAmount: 100, paymentCurrency: 'DKK', extraSeatNumber: 4, extraSeatAmount: 75, extraSeatCurrency: 'DKK', extraSeatFree: false, correctionReason: 'Telefonnummeret var tastet forkert' } })).value;
    assert.equal(salesCorrectedTicket.cashAmount, 175);
    assert.equal(salesCorrectedTicket.extraSeatNumber, 4);
    assert.equal(salesCorrectedTicket.editHistory.at(-1).editedBy, salesManager.id);
    const driverTicket = (await expectStatus(baseUrl, 201, `/api/trips/${trip.id}/passengers`, { method: 'POST', cookie: driver, body: { name: 'Billet i bussen', phone: '67676767', pickupStopId: extraStop.id, destinationStopId: destination.id, paymentStatus: 'cash', paymentCurrency: 'EUR', cashAmount: 40, seatNumber: 5, extraSeatNumber: 6, extraSeatFree: true, extraSeatReason: 'Gratis komfortsæde' } })).value;
    assert.equal(driverTicket.pickupStopId, extraStop.id);
    assert.equal(driverTicket.paymentLocation, 'bus');
    assert.equal(driverTicket.paymentRecordedBy, 2);
    assert.equal(driverTicket.cashHolderUserId, 2);
    assert.equal(driverTicket.extraSeatNumber, 6);
    assert.equal(driverTicket.extraSeatAmount, 0);
    assert.equal(driverTicket.extraSeatFree, true);
    await expectStatus(baseUrl, 400, `/api/trips/${trip.id}/passengers`, { method: 'PATCH', cookie: driver, body: { id: driverTicket.id, edit: true, name: driverTicket.name, phone: driverTicket.phone, pickupStopId: driverTicket.pickupStopId, destinationStopId: driverTicket.destinationStopId, seatNumber: driverTicket.seatNumber, cashAmount: driverTicket.cashAmount, paymentCurrency: driverTicket.paymentCurrency } });
    const correctedPassenger = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/passengers`, { method: 'PATCH', cookie: driver, body: { id: driverTicket.id, edit: true, name: 'Rettet Billetkunde', phone: '67670000', pickupStopId: extraStop.id, destinationStopId: destination.id, seatNumber: 7, cashAmount: 40, paymentCurrency: 'EUR', extraSeatNumber: 8, extraSeatFree: true, extraSeatReason: 'Gratis komfortsæde', correctionReason: 'Navn, telefon og sæde var tastet forkert' } })).value;
    assert.equal(correctedPassenger.seatNumber, 7);
    assert.equal(correctedPassenger.editHistory.at(-1).editedBy, 2);
    assert.equal(correctedPassenger.editHistory.at(-1).editedByName, 'Mads Chauffør');
    const noShowPassenger = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/passengers`, { method: 'PATCH', cookie: driver, body: { id: driverTicket.id, attendanceStatus: 'no_show' } })).value;
    assert.equal(noShowPassenger.attendanceStatus, 'no_show');
    assert.equal(noShowPassenger.checkedIn, false);
    assert.equal(noShowPassenger.attendanceHistory.at(-1).action, 'no_show');
    assert.equal(noShowPassenger.attendanceHistory.at(-1).userId, 2);
    const salesTripView = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}`, { cookie: sales })).value;
    assert.equal(salesTripView.passengers.length, 5);
    assert.ok(salesTripView.passengers.some(passenger => passenger.pickupStopId === extraStop.id));
    const mistakenPassenger = (await expectStatus(baseUrl, 201, `/api/trips/${trip.id}/passengers`, { method: 'POST', cookie: admin, body: { name: 'Oprettet ved fejl', phone: '68680000', pickupStopId: origin.id, destinationStopId: destination.id, paymentStatus: 'unpaid', seatNumber: 6 } })).value;
    await expectStatus(baseUrl, 400, `/api/trips/${trip.id}/passengers`, { method: 'DELETE', cookie: driver, body: { id: mistakenPassenger.id } });
    const deletedPassenger = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/passengers`, { method: 'DELETE', cookie: driver, body: { id: mistakenPassenger.id, deletionReason: 'Passageren blev oprettet ved en fejl' } })).value;
    assert.equal(deletedPassenger.freedSeatNumber, 6);
    const seatsAfterPassengerDeletion = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/seats`, { cookie: driver })).value;
    assert.equal(seatsAfterPassengerDeletion.find(seat => seat.number === 6).passengerId, null);
    await expectStatus(baseUrl, 404, `/api/trips/${trip.id}/passengers`, { method: 'DELETE', cookie: driver, body: { id: mistakenPassenger.id, deletionReason: 'Forsøger igen' } });
    await expectStatus(baseUrl, 403, `/api/trips/${trip.id}/passengers`, { method: 'POST', cookie: spare, body: { name: 'Ikke tildelt chauffør', phone: '68686868', pickupStopId: origin.id, destinationStopId: destination.id, paymentStatus: 'cash', paymentCurrency: 'DKK', cashAmount: 100, seatNumber: 5 } });

    const baggagePhotoData = `data:image/png;base64,${Buffer.from('busops-baggage-photo').toString('base64')}`;
    await expectStatus(baseUrl, 400, `/api/trips/${trip.id}/baggage`, { method: 'POST', cookie: admin, body: { senderName: 'Ugyldigt antal', recipientName: 'Modtager', phone: '70000009', pickupStopId: origin.id, destinationStopId: destination.id, pieces: 1.5, paymentStatus: 'unpaid', photoName: 'ugyldig.png', photoType: 'image/png', photoData: baggagePhotoData } });
    await expectStatus(baseUrl, 400, `/api/trips/${trip.id}/baggage`, { method: 'POST', cookie: admin, body: { senderName: 'Ukendt stop', recipientName: 'Modtager', phone: '70000008', pickupStopId: 999999, destinationStopId: destination.id, pieces: 1, paymentStatus: 'unpaid', photoName: 'ukendt.png', photoType: 'image/png', photoData: baggagePhotoData } });
    const largeBaggagePhotoData = `data:image/png;base64,${Buffer.alloc(6 * 1024 * 1024, 0x42).toString('base64')}`;
    await expectStatus(baseUrl, 400, `/api/trips/${trip.id}/baggage`, { method: 'POST', cookie: admin, body: { senderName: 'Uden foto', recipientName: 'Modtager A', phone: '70000000', pickupStopId: origin.id, destinationStopId: destination.id, pieces: 1, paymentStatus: 'unpaid' } });
    const externalPaymentBaggage = (await expectStatus(baseUrl, 201, `/api/trips/${trip.id}/baggage`, { method: 'POST', cookie: admin, body: { senderName: 'Kontorbagage MK', recipientName: 'Modtager MK', phone: '70000003', pickupStopId: origin.id, destinationStopId: destination.id, pieces: 1, paymentStatus: 'pay_mk', photoName: 'mk.png', photoType: 'image/png', photoData: baggagePhotoData } })).value;
    await expectStatus(baseUrl, 403, `/api/trips/${trip.id}/baggage`, { method: 'PATCH', cookie: driver, body: { id: externalPaymentBaggage.id, confirmExternalPayment: true, amount: 35, currency: 'EUR' } });
    const confirmedExternalBaggage = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/baggage`, { method: 'PATCH', cookie: sales, body: { id: externalPaymentBaggage.id, confirmExternalPayment: true, amount: 35, currency: 'EUR', note: 'Bekræftet af Tetovo-kontoret' } })).value;
    assert.equal(confirmedExternalBaggage.externalPaymentCurrency, 'EUR');
    assert.equal(confirmedExternalBaggage.externalPaymentConfirmedByName, 'Test Salgschef');
    assert.equal(confirmedExternalBaggage.cashHolderUserId, null);
    await expectStatus(baseUrl, 409, `/api/trips/${trip.id}/baggage`, { method: 'PATCH', cookie: driver, body: { id: externalPaymentBaggage.id, paymentStatus: 'cash', cashAmount: 35, paymentCurrency: 'EUR', paymentLocation: 'bus' } });
    await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/baggage`, { method: 'DELETE', cookie: admin, body: { id: externalPaymentBaggage.id, deletionReason: 'Fjerner betalingsbekræftelsestesten igen' } });
    const driverBaggage = (await expectStatus(baseUrl, 201, `/api/trips/${trip.id}/baggage`, { method: 'POST', cookie: admin, body: { senderName: 'Bagage A', recipientName: 'Modtager B', phone: '77777777', pickupStopId: origin.id, destinationStopId: destination.id, pieces: 2, description: 'Kufferter', paymentStatus: 'pay_mk', photoName: 'bagage.png', photoType: 'image/png', photoData: largeBaggagePhotoData } })).value;
    assert.ok(driverBaggage.photoFile);
    assert.equal(driverBaggage.paymentStatus, 'pay_mk');
    const mistakenBaggage = (await expectStatus(baseUrl, 201, `/api/trips/${trip.id}/baggage`, { method: 'POST', cookie: admin, body: { senderName: 'Fejlbagage', recipientName: 'Forkert modtager', phone: '70000001', pickupStopId: origin.id, destinationStopId: destination.id, pieces: 1, paymentStatus: 'pay_dk', photoName: 'fejl.png', photoType: 'image/png', photoData: baggagePhotoData } })).value;
    const salesCorrectedBaggage = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/baggage`, { method: 'PATCH', cookie: sales, body: { id: mistakenBaggage.id, edit: true, senderName: 'Fejlbagage rettet', recipientName: 'Rigtig modtager', phone: '70000002', pickupStopId: origin.id, destinationStopId: destination.id, pieces: 1, description: 'Testpakke', notes: '', correctionReason: 'Modtager og telefon var tastet forkert' } })).value;
    assert.equal(salesCorrectedBaggage.editHistory.at(-1).editedBy, salesManager.id);
    await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/baggage`, { method: 'DELETE', cookie: sales, body: { id: mistakenBaggage.id, deletionReason: 'Bagagen blev oprettet ved en fejl' } });
    await expectStatus(baseUrl, 404, `/api/baggage/${mistakenBaggage.id}/photo`, { cookie: admin });
    const tripAfterDeletions = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}`, { cookie: admin })).value;
    assert.ok(tripAfterDeletions.trip.deletionHistory.some(event => event.kind === 'passenger'));
    assert.equal(tripAfterDeletions.trip.deletionHistory.at(-1).kind, 'baggage');
    const remoteSalesBaggage=(await expectStatus(baseUrl, 201, `/api/trips/${trip.id}/baggage`, { method: 'POST', cookie: otherSales, body: { senderName: 'Bagage fra Berlin', recipientName: 'Modtager C', phone: '77777777', pickupStopId: extraStop.id, destinationStopId: destination.id, pieces: 1, paymentStatus: 'cash', cashAmount: 50, paymentCurrency: 'DKK', photoName: 'berlin.png', photoType: 'image/png', photoData: baggagePhotoData } })).value;
    assert.equal(remoteSalesBaggage.paymentLocation,'shop');
    assert.equal(remoteSalesBaggage.cashHolderUserId,otherSalesManager.id);
    assert.equal(remoteSalesBaggage.salesOfficeCountry,'DE');
    await expectStatus(baseUrl,403,`/api/trips/${trip.id}/baggage`,{method:'PATCH',cookie:otherSales,body:{id:remoteSalesBaggage.id,status:'received'}});
    await expectStatus(baseUrl,200,`/api/trips/${trip.id}/baggage`,{method:'DELETE',cookie:otherSales,body:{id:remoteSalesBaggage.id,deletionReason:'Fjerner global bagagetest'}});
    await expectStatus(baseUrl, 201, `/api/trips/${trip.id}/baggage`, { method: 'POST', cookie: sales, body: { senderName: 'Bagage ved start', recipientName: 'Modtager D', phone: '88888888', pickupStopId: origin.id, destinationStopId: destination.id, pieces: 1, description: 'Pakke', paymentStatus: 'cash', cashAmount: 50, paymentCurrency: 'DKK', photoName: 'pakke.png', photoType: 'image/png', photoData: baggagePhotoData } });
    await expectStatus(baseUrl, 403, `/api/trips/${trip.id}/baggage`, { method: 'POST', cookie: driver, body: { senderName: 'Ubetalt i bus', recipientName: 'Modtager E', phone: '89898989', pickupStopId: origin.id, destinationStopId: destination.id, pieces: 1, paymentStatus: 'unpaid', photoName: 'ubetalt.png', photoType: 'image/png', photoData: baggagePhotoData } });
    const baggageInBus = (await expectStatus(baseUrl, 201, `/api/trips/${trip.id}/baggage`, { method: 'POST', cookie: driver, body: { senderName: 'Bagage i bussen', recipientName: 'Modtager F', phone: '89898989', pickupStopId: origin.id, destinationStopId: destination.id, pieces: 1, description: 'Taske', paymentStatus: 'cash', cashAmount: 30, paymentCurrency: 'DKK', photoName: 'taske.png', photoType: 'image/png', photoData: baggagePhotoData } })).value;
    assert.equal(baggageInBus.paymentLocation, 'bus');
    assert.equal(baggageInBus.paymentRecordedBy, 2);
    assert.equal(baggageInBus.cashHolderUserId, 2);
    assert.ok(baggageInBus.photoFile);
    const correctedBaggage = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/baggage`, { method: 'PATCH', cookie: secondaryDriver, body: { id: baggageInBus.id, edit: true, senderName: baggageInBus.senderName, recipientName: 'Ny modtager', phone: baggageInBus.phone, pickupStopId: baggageInBus.pickupStopId, destinationStopId: baggageInBus.destinationStopId, pieces: 2, description: 'To tasker', notes: 'Rettet ved optælling', cashAmount: 30, paymentCurrency: 'DKK', correctionReason: 'Antal kolli og modtager var forkert' } })).value;
    assert.equal(correctedBaggage.pieces, 2);
    assert.equal(correctedBaggage.editHistory.at(-1).editedBy, 3);
    assert.equal(correctedBaggage.recipientName, 'Ny modtager');
    await expectStatus(baseUrl, 403, `/api/trips/${trip.id}/baggage`, { method: 'POST', cookie: spare, body: { senderName: 'Ikke tildelt', recipientName: 'Modtager G', phone: '90909090', pickupStopId: origin.id, destinationStopId: destination.id, pieces: 1, paymentStatus: 'cash', cashAmount: 30, paymentCurrency: 'DKK', photoName: 'afvist.png', photoType: 'image/png', photoData: baggagePhotoData } });
    const baggagePhoto = await expectStatus(baseUrl, 200, `/api/baggage/${driverBaggage.id}/photo`, { cookie: driver });
    assert.equal(baggagePhoto.response.headers.get('content-type'), 'image/png');
    await expectStatus(baseUrl, 403, `/api/baggage/${driverBaggage.id}/photo`, { cookie: spare });

    const salesCheckIn = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/passengers`, { method: 'PATCH', cookie: sales, body: { id: unpaidPassenger.id, checkedIn: true } })).value;
    assert.equal(salesCheckIn.checkedInBy, salesManager.id);
    assert.equal(salesCheckIn.paymentStatus, 'pay_dk');
    const manuallyUnchecked = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/passengers`, { method: 'PATCH', cookie: driver, body: { id: unpaidPassenger.id, checkedIn: false } })).value;
    assert.equal(manuallyUnchecked.checkedIn, false);
    assert.equal(manuallyUnchecked.attendanceStatus, 'pending');
    assert.equal(manuallyUnchecked.attendanceHistory.at(-1).action, 'check_in_undone');
    assert.equal(manuallyUnchecked.attendanceHistory.at(-1).userId, 2);
    assert.equal(manuallyUnchecked.paymentStatus, 'pay_dk');
    const checkedInAgain = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/passengers`, { method: 'PATCH', cookie: sales, body: { id: unpaidPassenger.id, checkedIn: true } })).value;
    assert.equal(checkedInAgain.checkedIn, true);
    await expectStatus(baseUrl, 403, `/api/trips/${trip.id}`, { method: 'PATCH', cookie: otherSales, body: { completedStopId: extraStop.id } });
    const completedExtraStop = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}`, { method: 'PATCH', cookie: sales, body: { completedStopId: extraStop.id } })).value;
    assert.ok(completedExtraStop.completedStopIds.includes(extraStop.id));
    const paidPassenger = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/passengers`, { method: 'PATCH', cookie: driver, body: { id: unpaidPassenger.id, paymentStatus: 'cash', cashAmount: 500, paymentCurrency: 'DKK', paymentLocation: 'bus' } })).value;
    assert.equal(paidPassenger.cashHolderUserId, 2);
    const unchangedPayment = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/passengers`, { method: 'PATCH', cookie: driver, body: { id: unpaidPassenger.id, paymentStatus: 'unpaid' } })).value;
    assert.equal(unchangedPayment.paymentStatus, 'cash');
    await expectStatus(baseUrl, 409, `/api/trips/${trip.id}`, { method: 'PATCH', cookie: admin, body: { primaryDriverId: 3, secondaryDriverId: 2 } });

    await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/baggage`, { method: 'PATCH', cookie: driver, body: { id: driverBaggage.id, paymentStatus: 'cash', cashAmount: 20, paymentCurrency: 'EUR', paymentLocation: 'bus' } });
    for (const status of ['received', 'onboard', 'delivered']) {
      const updated = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/baggage`, { method: 'PATCH', cookie: driver, body: { id: driverBaggage.id, status } })).value;
      assert.equal(updated.status, status);
    }

    const salesExpense = (await expectStatus(baseUrl, 201, `/api/trips/${trip.id}/expenses`, { method: 'POST', cookie: sales, body: { category: 'Husleje til billetkontor', description: 'Kontorets andel til denne afgang', amount: 50, currency: 'DKK', paymentMethod: 'company_card', receiptName: 'husleje.png', receiptType: 'image/png', receiptData: baggagePhotoData } })).value;
    assert.equal(salesExpense.paymentMethod, 'cash');
    assert.equal(salesExpense.expenseScope, 'sales_preparation');
    assert.equal(salesExpense.cashBoxUserId, salesManager.id);
    assert.equal(salesExpense.cashPaymentAllocations.reduce((sum,item)=>sum+item.amount,0), 50);
    await expectStatus(baseUrl, 409, `/api/trips/${trip.id}/expenses`, { method: 'POST', cookie: sales, body: { category: 'For stor udgift', amount: 9999, currency: 'DKK' } });
    const salesExpenseView = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}`, { cookie: sales })).value;
    assert.equal(salesExpenseView.expenses.length, 1);
    assert.equal(salesExpenseView.cashBoxes.find(box=>box.holderId===salesManager.id).totals.DKK, 175);
    assert.equal(salesExpenseView.cashBoxes.find(box=>box.holderId===salesManager.id).cashExpenseTotals.DKK, 50);
    const driverExpenseView = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}`, { cookie: driver })).value;
    assert.ok(!driverExpenseView.expenses.some(item=>item.id===salesExpense.id));
    await expectStatus(baseUrl, 403, `/api/expenses/${salesExpense.id}/receipt`, { cookie: driver });
    await expectStatus(baseUrl, 200, `/api/expenses/${salesExpense.id}/receipt`, { cookie: sales });
    const correctedSalesExpense = (await expectStatus(baseUrl, 200, `/api/expenses/${salesExpense.id}`, { method: 'PATCH', cookie: sales, body: { edit: true, category: salesExpense.category, description: 'Husleje og klargøring af billetkontoret', amount: 50, currency: 'DKK', paymentMethod: 'cash', paidByUserId: salesManager.id, correctionReason: 'Beskrivelsen skulle være mere præcis' } })).value;
    assert.equal(correctedSalesExpense.editHistory.at(-1).editedBy, salesManager.id);
    await expectStatus(baseUrl, 409, `/api/trips/${trip.id}/transfers`, { method: 'POST', cookie: sales, body: { toDriverId: 2, amountDKK:125, amountEUR:0, note: 'Må vente på udgiftsgodkendelse' } });
    await expectStatus(baseUrl, 200, `/api/expenses/${salesExpense.id}`, { method: 'PATCH', cookie: admin, body: { status: 'approved', reviewNote: 'Dokumenteret forberedelsesudgift' } });
    const expense = (await expectStatus(baseUrl, 201, `/api/trips/${trip.id}/expenses`, { method: 'POST', cookie: driver, body: { category: 'Brændstof', description: 'Tankning', amount: 120, currency: 'DKK', paymentMethod: 'private' } })).value;
    assert.equal(expense.status, 'pending');
    assert.equal(expense.receiptFile, null);
    const correctedExpense = (await expectStatus(baseUrl, 200, `/api/expenses/${expense.id}`, { method: 'PATCH', cookie: secondaryDriver, body: { edit: true, category: 'Brændstof', description: 'Tankning og AdBlue', amount: 125, currency: 'DKK', paymentMethod: 'private', paidByUserId: 2, correctionReason: 'Kvitteringens total var forkert' } })).value;
    assert.equal(correctedExpense.amount, 125);
    assert.equal(correctedExpense.editHistory.at(-1).editedBy, 3);
    await expectStatus(baseUrl, 409, `/api/expenses/${expense.id}`, { method: 'PATCH', cookie: admin, body: { status: 'approved' } });
    const receiptData = `data:image/png;base64,${Buffer.from('busops-receipt').toString('base64')}`;
    const withReceipt = (await expectStatus(baseUrl, 200, `/api/expenses/${expense.id}`, { method: 'PATCH', cookie: driver, body: { receiptName: 'kvittering.png', receiptType: 'image/png', receiptData } })).value;
    assert.ok(withReceipt.receiptFile);
    const receipt = await expectStatus(baseUrl, 200, `/api/expenses/${expense.id}/receipt`, { cookie: driver });
    assert.equal(receipt.response.headers.get('content-type'), 'image/png');
    await expectStatus(baseUrl, 403, `/api/expenses/${expense.id}/receipt`, { cookie: sales });
    await expectStatus(baseUrl, 200, `/api/expenses/${expense.id}`, { method: 'PATCH', cookie: admin, body: { status: 'approved', reviewNote: 'OK' } });
    const reimbursed = (await expectStatus(baseUrl, 200, `/api/expenses/${expense.id}`, { method: 'PATCH', cookie: admin, body: { reimbursementStatus: 'paid' } })).value;
    assert.equal(reimbursed.reimbursementStatus, 'paid');

    const transfer = (await expectStatus(baseUrl, 201, `/api/trips/${trip.id}/transfers`, { method: 'POST', cookie: driver, body: { toDriverId: 3, paymentRefs: [`baggage:${baggageInBus.id}`], note: 'Kontanter afleveret i bussen' } })).value;
    assert.equal(transfer.status, 'pending');
    assert.deepEqual(transfer.totals, { DKK: 30, EUR: 0 });
    await expectStatus(baseUrl, 403, `/api/trips/${trip.id}/transfers`, { method: 'PATCH', cookie: driver, body: { id: transfer.id, status: 'accepted' } });
    await expectStatus(baseUrl, 409, `/api/trips/${trip.id}/settlements`, { method: 'POST', cookie: driver, body: { deliveredDKK: 530, deliveredEUR: 60 } });
    const acceptedTransfer = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/transfers`, { method: 'PATCH', cookie: secondaryDriver, body: { id: transfer.id, status: 'accepted' } })).value;
    assert.equal(acceptedTransfer.status, 'accepted');
    await expectStatus(baseUrl, 409, `/api/trips/${trip.id}/baggage`, { method: 'DELETE', cookie: secondaryDriver, body: { id: baggageInBus.id, deletionReason: 'Må ikke bryde kontanthistorikken' } });
    const transferredTrip = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}`, { cookie: secondaryDriver })).value;
    assert.equal(transferredTrip.baggage.find(item => item.id === baggageInBus.id).cashHolderUserId, 3);

    const driverDashboard = (await expectStatus(baseUrl, 200, '/api/dashboard', { cookie: driver })).value;
    assert.equal(driverDashboard.cashHeld.DKK, 500);
    assert.equal(driverDashboard.cashHeld.EUR, 60);
    const secondaryDashboard = (await expectStatus(baseUrl, 200, '/api/dashboard', { cookie: secondaryDriver })).value;
    assert.equal(secondaryDashboard.cashHeld.DKK, 30);
    const salesDashboard = (await expectStatus(baseUrl, 200, '/api/dashboard', { cookie: sales })).value;
    assert.equal(salesDashboard.cashHeld.DKK, 175);
    assert.equal(salesDashboard.cashHeld.expenses.DKK, 50);
    const personalCashbox = (await expectStatus(baseUrl, 200, '/api/my-cashbox', { cookie: sales })).value;
    assert.equal(personalCashbox.holder.id, salesManager.id);
    assert.deepEqual(personalCashbox.summary.gross, { DKK: 225, EUR: 0 });
    assert.deepEqual(personalCashbox.summary.expenses, { DKK: 50, EUR: 0 });
    assert.deepEqual(personalCashbox.summary.available, { DKK: 175, EUR: 0 });
    assert.equal(personalCashbox.byTrip.length, 1);
    assert.equal(personalCashbox.byTrip[0].tripId, trip.id);
    const isolatedOtherCashbox = (await expectStatus(baseUrl, 200, '/api/my-cashbox', { cookie: otherSales })).value;
    assert.deepEqual(isolatedOtherCashbox.summary.available, { DKK: 0, EUR: 0 });
    assert.deepEqual(isolatedOtherCashbox.byTrip, []);
    const driverPersonalCashbox = (await expectStatus(baseUrl, 200, '/api/my-cashbox', { cookie: driver })).value;
    assert.equal(driverPersonalCashbox.holder.role, 'driver');
    assert.deepEqual(driverPersonalCashbox.summary.available, { DKK: 500, EUR: 60 });
    await expectStatus(baseUrl, 403, '/api/my-cashbox', { cookie: admin });

    const tripBudget = (await expectStatus(baseUrl, 201, `/api/trips/${trip.id}/transfers`, { method: 'POST', cookie: sales, body: { toDriverId: 2, amountDKK:125, amountEUR:0, note: 'Startbudget til turudgifter' } })).value;
    assert.equal(tripBudget.transferType, 'trip_budget');
    assert.deepEqual(tripBudget.totals, { DKK: 125, EUR: 0 });
    await expectStatus(baseUrl, 403, `/api/trips/${trip.id}/transfers`, { method: 'PATCH', cookie: sales, body: { id: tripBudget.id, status: 'accepted' } });
    const acceptedBudget = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/transfers`, { method: 'PATCH', cookie: driver, body: { id: tripBudget.id, status: 'accepted' } })).value;
    assert.equal(acceptedBudget.toUserId, 2);
    assert.equal(acceptedBudget.fromUserId, salesManager.id);
    assert.equal(acceptedBudget.sourceDetailsRestricted, true);
    assert.equal(acceptedBudget.sourcePaymentCount, 1);
    assert.deepEqual(acceptedBudget.paymentRefs, []);
    const driverDashboardWithBudget = (await expectStatus(baseUrl, 200, '/api/dashboard', { cookie: driver })).value;
    assert.equal(driverDashboardWithBudget.cashHeld.DKK, 625);
    const driverBudgetView = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}`, { cookie: driver })).value;
    assert.deepEqual(driverBudgetView.transfers.find(item => item.id === tripBudget.id).paymentRefs, []);
    const driverCashBox = driverBudgetView.cashBoxes.find(item => item.holderId === 2);
    assert.deepEqual(driverCashBox.budgetTotals, { DKK: 125, EUR: 0 });
    assert.equal(driverCashBox.budgetPayments, 1);
    const budgetTripView = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}`, { cookie: sales })).value;
    assert.equal(budgetTripView.passengers.find(item => item.id === salesTicket.id).cashHolderUserId, salesManager.id);
    assert.deepEqual(budgetTripView.transfers.find(item => item.id === tripBudget.id).paymentRefs, []);

    const driverCashExpense = (await expectStatus(baseUrl, 201, `/api/trips/${trip.id}/expenses`, { method: 'POST', cookie: driver, body: { category: 'Vejafgift', description: 'Kontant vejafgift fra turbudget', amount: 25, currency: 'DKK', paymentMethod: 'cash', receiptName: 'vejafgift.png', receiptType: 'image/png', receiptData: receiptData } })).value;
    assert.equal(driverCashExpense.cashBoxUserId, 2);
    assert.equal(driverCashExpense.cashPaymentAllocations.reduce((sum,item)=>sum+item.amount,0), 25);
    await expectStatus(baseUrl, 200, `/api/expenses/${driverCashExpense.id}`, { method: 'PATCH', cookie: admin, body: { status: 'approved', reviewNote: 'Kontant udgift dokumenteret' } });
    const driverCashboxAfterExpense = (await expectStatus(baseUrl, 200, '/api/my-cashbox', { cookie: driver })).value;
    assert.deepEqual(driverCashboxAfterExpense.summary.available, { DKK: 600, EUR: 60 });
    assert.deepEqual(driverCashboxAfterExpense.summary.expenses, { DKK: 25, EUR: 0 });

    const driverSettlement = (await expectStatus(baseUrl, 201, `/api/trips/${trip.id}/settlements`, { method: 'POST', cookie: driver, body: { deliveredDKK: 600, deliveredEUR: 60 } })).value;
    assert.deepEqual(driverSettlement.expected, { DKK: 600, EUR: 60 });
    await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/settlements`, { method: 'PATCH', cookie: admin, body: { id: driverSettlement.id, status: 'approved' } });
    const settledDriverCashbox = (await expectStatus(baseUrl, 200, '/api/my-cashbox', { cookie: driver })).value;
    assert.deepEqual(settledDriverCashbox.summary.available, { DKK: 0, EUR: 0 });
    await expectStatus(baseUrl, 400, `/api/trips/${trip.id}/settlements`, { method: 'POST', cookie: driver, body: { deliveredDKK: 0, deliveredEUR: 0 } });
    const secondarySettlement = (await expectStatus(baseUrl, 201, `/api/trips/${trip.id}/settlements`, { method: 'POST', cookie: secondaryDriver, body: { deliveredDKK: 30, deliveredEUR: 0 } })).value;
    assert.deepEqual(secondarySettlement.expected, { DKK: 30, EUR: 0 });
    await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/settlements`, { method: 'PATCH', cookie: admin, body: { id: secondarySettlement.id, status: 'approved' } });
    const salesSettlement = (await expectStatus(baseUrl, 201, `/api/trips/${trip.id}/settlements`, { method: 'POST', cookie: sales, body: { deliveredDKK: 50, deliveredEUR: 0 } })).value;
    assert.deepEqual(salesSettlement.expected, { DKK: 50, EUR: 0 });
    await expectStatus(baseUrl, 200, `/api/trips/${trip.id}/settlements`, { method: 'PATCH', cookie: admin, body: { id: salesSettlement.id, status: 'approved' } });

    const reports = (await expectStatus(baseUrl, 200, '/api/reports', { cookie: admin })).value;
    assert.equal(reports.summary.tickets, 5);
    assert.equal(reports.summary.paidTickets, 4);
    assert.equal(reports.summary.freeTickets, 1);
    assert.deepEqual(reports.summary.ticketRevenue, { DKK: 675, EUR: 65 });
    assert.equal(reports.summary.baggage, 3);
    assert.equal(reports.summary.paidBaggage, 3);
    assert.deepEqual(reports.summary.baggageRevenue, { DKK: 80, EUR: 20 });
    assert.deepEqual(reports.summary.expenseTotals, { DKK: 200, EUR: 0 });
    assert.ok(reports.expenses.some(item=>item.id===salesExpense.id&&item.expenseScope==='sales_preparation'));
    assert.deepEqual(reports.tripResults[0].net, { DKK: 555, EUR: 85 });
    assert.deepEqual(reports.summary.cashAtOffice, { DKK: 680, EUR: 60 });
    assert.ok(reports.ledger.some(item=>item.kind==='revenue'&&item.source==='passenger'&&item.signedAmount>0));
    assert.ok(reports.ledger.some(item=>item.kind==='expense'&&item.sourceId===driverCashExpense.id&&item.signedAmount<0));
    assert.ok(reports.ledger.some(item=>item.kind==='transfer'&&item.signedAmount===0));
    assert.ok(reports.ledger.some(item=>item.kind==='settlement'&&item.signedAmount===0));
    assert.ok(reports.ledger.some(item=>item.kind==='correction'&&item.source==='passenger'&&item.signedAmount<0));
    assert.ok(reports.ledger.every(item=>/^KAS-\d{4}-\d{6}$/.test(item.postingNumber)));
    assert.equal(new Set(reports.ledger.map(item=>item.postingNumber)).size,reports.ledger.length);
    assert.ok(reports.cashLedger.byHolder.some(item=>item.holderType==='office'));
    assert.ok(reports.cashLedger.byHolder.every(item=>['DKK','EUR'].every(currency=>Number.isFinite(item.closing[currency]))));

    const adminDashboard = (await expectStatus(baseUrl, 200, '/api/dashboard', { cookie: admin })).value;
    assert.equal(adminDashboard.cashHeld.payments, 0);
    await expectStatus(baseUrl, 403, `/api/trips/${trip.id}`, { method: 'PATCH', cookie: driver, body: { status: 'cancelled', cancellationReason: 'Ikke tilladt' } });
    await expectStatus(baseUrl, 400, `/api/trips/${trip.id}`, { method: 'PATCH', cookie: admin, body: { status: 'cancelled', cancellationReason: '' } });
    const cancelledTrip = (await expectStatus(baseUrl, 200, `/api/trips/${trip.id}`, { method: 'PATCH', cookie: admin, body: { status: 'cancelled', cancellationReason: 'Afgangen er aflyst af driften' } })).value;
    assert.equal(cancelledTrip.status, 'cancelled');
    assert.equal(cancelledTrip.cancellationReason, 'Afgangen er aflyst af driften');
    assert.equal(cancelledTrip.cancelledByName, 'Administrator');
    assert.ok(cancelledTrip.cancelledAt);
    const cancellationDrafts=(await expectStatus(baseUrl,200,`/api/trips/${trip.id}`,{cookie:admin})).value.notifications.filter(item=>item.type==='trip_cancelled');
    assert.ok(cancellationDrafts.length>0);
    await expectStatus(baseUrl, 409, `/api/trips/${trip.id}/passengers`, { method: 'POST', cookie: admin, body: { name: 'Efter annullering', phone: '10101010', pickupStopId: origin.id, destinationStopId: destination.id, paymentStatus: 'unpaid', seatNumber: 5 } });
    await expectStatus(baseUrl, 409, `/api/trips/${trip.id}/passengers`, { method: 'PATCH', cookie: driver, body: { id: unpaidPassenger.id, checkedIn: true } });
    await expectStatus(baseUrl, 409, `/api/trips/${trip.id}`, { method: 'DELETE', cookie: admin });
    await expectStatus(baseUrl, 409, `/api/stops/${origin.id}`, { method: 'DELETE', cookie: admin });
    await expectStatus(baseUrl, 409, `/api/buses/${doubleBus.id}`, { method: 'DELETE', cookie: admin });
    await expectStatus(baseUrl, 409, '/api/drivers/2', { method: 'DELETE', cookie: admin });
    await expectStatus(baseUrl, 200, `/api/drivers/${spareDriver.id}`, { method: 'DELETE', cookie: admin });
    await expectStatus(baseUrl, 200, `/api/buses/${standardBus.id}`, { method: 'DELETE', cookie: admin });

    const closureTrip = (await expectStatus(baseUrl, 201, '/api/trips', { method:'POST',cookie:admin,body:{ title:'Kontrolleret afslutning',departureAt:new Date(Date.now()+259200000).toISOString(),destinationArrivalAt:new Date(Date.now()+259200000+720*60000).toISOString(),originId:origin.id,destinationId:destination.id,busId:doubleBus.id,primaryDriverId:2,secondaryDriverId:3 } })).value;
    const closurePassenger = (await expectStatus(baseUrl,201,`/api/trips/${closureTrip.id}/passengers`,{method:'POST',cookie:admin,body:{name:'Afslutningstest',phone:'90909090',pickupStopId:origin.id,destinationStopId:destination.id,paymentStatus:'unpaid',seatNumber:10}})).value;
    const blockedClosure = await expectStatus(baseUrl,409,`/api/trips/${closureTrip.id}`,{method:'PATCH',cookie:admin,body:{status:'completed'}});
    assert.equal(blockedClosure.value.blockers.passengers.length,1);
    const blockedDriverListClosure=await expectStatus(baseUrl,409,`/api/trips/${closureTrip.id}`,{method:'PATCH',cookie:driver,body:{passengerListClosed:true}});
    assert.equal(blockedDriverListClosure.value.blockers.passengers[0].name,'Afslutningstest');
    await expectStatus(baseUrl,403,`/api/trips/${closureTrip.id}`,{method:'PATCH',cookie:sales,body:{passengerListClosed:true}});
    await expectStatus(baseUrl,200,`/api/trips/${closureTrip.id}/passengers`,{method:'PATCH',cookie:driver,body:{id:closurePassenger.id,attendanceStatus:'no_show'}});
    const boardingTrip=(await expectStatus(baseUrl,200,`/api/trips/${closureTrip.id}`,{method:'PATCH',cookie:driver,body:{operationalAction:'start_boarding'}})).value;
    assert.equal(boardingTrip.operationalPhase,'boarding');
    await expectStatus(baseUrl,409,`/api/trips/${closureTrip.id}`,{method:'PATCH',cookie:driver,body:{operationalAction:'start_trip'}});
    for(const departureChecklistItem of ['vehicle_ready','route_documents','passenger_list','baggage_secured','cash_budget'])await expectStatus(baseUrl,200,`/api/trips/${closureTrip.id}`,{method:'PATCH',cookie:driver,body:{departureChecklistItem,checked:true}});
    const startedTrip=(await expectStatus(baseUrl,200,`/api/trips/${closureTrip.id}`,{method:'PATCH',cookie:driver,body:{operationalAction:'start_trip'}})).value;
    assert.equal(startedTrip.operationalPhase,'underway');
    assert.equal(startedTrip.startSource,'manual');
    const closedPassengerList=(await expectStatus(baseUrl,200,`/api/trips/${closureTrip.id}`,{method:'PATCH',cookie:driver,body:{passengerListClosed:true,note:'Alle passagerer behandlet'}})).value;
    assert.ok(closedPassengerList.passengerListClosedAt);
    assert.equal(closedPassengerList.passengerListClosedByName,'Mads Chauffør');
    await expectStatus(baseUrl,200,`/api/trips/${closureTrip.id}/passengers`,{method:'PATCH',cookie:driver,body:{id:closurePassenger.id,checkedIn:true}});
    const reopenedPassengerList=(await expectStatus(baseUrl,200,`/api/trips/${closureTrip.id}`,{cookie:driver})).value;
    assert.equal(reopenedPassengerList.trip.passengerListClosedAt,null);
    await expectStatus(baseUrl,200,`/api/trips/${closureTrip.id}`,{method:'PATCH',cookie:driver,body:{passengerListClosed:true,note:'Genkontrolleret efter rettelse'}});
    const arrivedTrip=(await expectStatus(baseUrl,200,`/api/trips/${closureTrip.id}`,{method:'PATCH',cookie:driver,body:{operationalAction:'mark_arrived'}})).value;
    assert.equal(arrivedTrip.operationalPhase,'finance_pending');
    assert.equal(arrivedTrip.arrivalSource,'manual');
    const completedTrip=(await expectStatus(baseUrl,200,`/api/trips/${closureTrip.id}`,{method:'PATCH',cookie:driver,body:{status:'completed',closeNote:'Alle driftsforhold er kontrolleret'}})).value;
    assert.equal(completedTrip.status,'completed');
    assert.ok(completedTrip.operationsLockedAt);
    assert.equal(completedTrip.economyLockedAt,null);
    assert.equal(completedTrip.closedByName,'Mads Chauffør');
    const automaticZeroSettlements=(await expectStatus(baseUrl,200,`/api/trips/${closureTrip.id}`,{cookie:admin})).value.settlements.filter(item=>item.automaticZero);
    assert.equal(automaticZeroSettlements.length,2);
    assert.ok(automaticZeroSettlements.every(item=>item.status==='approved'&&item.expected.DKK===0&&item.expected.EUR===0));
    await expectStatus(baseUrl,409,`/api/trips/${closureTrip.id}/passengers`,{method:'POST',cookie:admin,body:{name:'Låst',phone:'91919191',pickupStopId:origin.id,destinationStopId:destination.id,paymentStatus:'unpaid',seatNumber:11}});
    const audit=(await expectStatus(baseUrl,200,`/api/audit?tripId=${closureTrip.id}`,{cookie:admin})).value;
    assert.ok(audit.events.some(event=>event.action==='trip.closed'));
    await expectStatus(baseUrl,403,`/api/audit?tripId=${closureTrip.id}`,{cookie:driver});
    const reopenedTrip=(await expectStatus(baseUrl,200,`/api/trips/${closureTrip.id}`,{method:'PATCH',cookie:admin,body:{status:'planned',reopenReason:'Passagerlisten skal korrigeres'}})).value;
    assert.equal(reopenedTrip.status,'planned');
    const afterReopenPassenger=(await expectStatus(baseUrl,201,`/api/trips/${closureTrip.id}/passengers`,{method:'POST',cookie:admin,body:{name:'Efter genåbning',phone:'92929292',pickupStopId:origin.id,destinationStopId:destination.id,paymentStatus:'unpaid',seatNumber:11}})).value;

    const outsideDriver=(await expectStatus(baseUrl,201,'/api/drivers',{method:'POST',cookie:admin,body:{name:'Chauffør uden for tur',email:'udenfortur@albaturist.dk',password:'udenfortur1234'}})).value;
    const outsideDriverLogin=await expectStatus(baseUrl,200,'/api/login',{method:'POST',body:{email:'udenfortur@albaturist.dk',password:'udenfortur1234'}}),outsideDriverCookie=cookieFrom(outsideDriverLogin.response);
    const globalCashPassenger=(await expectStatus(baseUrl,201,`/api/trips/${closureTrip.id}/passengers`,{method:'POST',cookie:driver,body:{name:'Global kontanttest',phone:'93939393',pickupStopId:origin.id,destinationStopId:destination.id,paymentStatus:'cash',paymentCurrency:'DKK',cashAmount:80,seatNumber:12}})).value;
    await expectStatus(baseUrl,200,`/api/trips/${closureTrip.id}/passengers`,{method:'PATCH',cookie:driver,body:{id:afterReopenPassenger.id,attendanceStatus:'no_show'}});
    await expectStatus(baseUrl,200,`/api/trips/${closureTrip.id}/passengers`,{method:'PATCH',cookie:driver,body:{id:globalCashPassenger.id,checkedIn:true}});
    await expectStatus(baseUrl,200,`/api/trips/${closureTrip.id}`,{method:'PATCH',cookie:driver,body:{passengerListClosed:true,note:'Alle nye passagerer behandlet'}});
    const cashTripClosedByDriver=(await expectStatus(baseUrl,200,`/api/trips/${closureTrip.id}`,{method:'PATCH',cookie:driver,body:{status:'completed',closeNote:'Driften afsluttet med kontanter i personlig pengekasse'}})).value;
    assert.equal(cashTripClosedByDriver.status,'completed');
    assert.equal(cashTripClosedByDriver.counts.unsettledCash,1);
    const driverCashboxAfterClosure=(await expectStatus(baseUrl,200,'/api/my-cashbox',{cookie:driver})).value;
    assert.ok(driverCashboxAfterClosure.transferable.some(item=>item.reference===`passenger:${globalCashPassenger.id}`));
    const driverToSales=(await expectStatus(baseUrl,201,'/api/cash-transfers',{method:'POST',cookie:driver,body:{toUserId:isolatedOtherCashbox.holder.id,paymentRefs:[`passenger:${globalCashPassenger.id}`],note:'Billetpenge afleveres til salgschef'}})).value;
    assert.equal(driverToSales.transferType,'sales_handover');
    // Sales managers may add missing sales without reopening completed operations.
    const latePath=`/api/trips/${closureTrip.id}`;
    const beforeLate=(await expectStatus(baseUrl,200,latePath,{cookie:sales})).value.trip;
    const lateBody={name:'Efterregistreret gæst',phone:'45454545',pickupStopId:origin.id,destinationStopId:destination.id,paymentStatus:'cash',cashAmount:100,paymentCurrency:'DKK',seatNumber:20};
    await expectStatus(baseUrl,409,`${latePath}/passengers`,{method:'POST',cookie:driver,body:lateBody});
    const latePassenger=(await expectStatus(baseUrl,201,`${latePath}/passengers`,{method:'POST',cookie:otherSales,body:lateBody})).value;
    assert.equal(latePassenger.cashHolderUserId,isolatedOtherCashbox.holder.id);
    await expectStatus(baseUrl,409,`${latePath}/passengers`,{method:'POST',cookie:sales,body:{...lateBody,name:'Optaget sæde',phone:'46464646'}});
    await expectStatus(baseUrl,409,`${latePath}/passengers`,{method:'PATCH',cookie:sales,body:{id:latePassenger.id,checkedIn:true}});
    await expectStatus(baseUrl,409,`${latePath}/passengers`,{method:'DELETE',cookie:sales,body:{id:latePassenger.id,reason:'Må ikke slette'}});
    await expectStatus(baseUrl,201,`${latePath}/group-bookings`,{method:'POST',cookie:sales,body:{phone:'47474747',pickupStopId:origin.id,destinationStopId:destination.id,paymentStatus:'unpaid',passengers:[{name:'Sen gruppe A',seatNumber:21},{name:'Sen gruppe B',seatNumber:22}]}});
    const lateBag={senderName:'Sen bagage',recipientName:'Modtager',phone:'48484848',pickupStopId:origin.id,destinationStopId:destination.id,pieces:1,paymentStatus:'unpaid',photoName:'sen.png',photoType:'image/png',photoData:baggagePhotoData};
    await expectStatus(baseUrl,409,`${latePath}/baggage`,{method:'POST',cookie:driver,body:lateBag});
    await expectStatus(baseUrl,201,`${latePath}/baggage`,{method:'POST',cookie:sales,body:lateBag});
    const afterLate=(await expectStatus(baseUrl,200,latePath,{cookie:sales})).value.trip;
    assert.equal(afterLate.status,'completed');
    assert.equal(afterLate.closedAt,beforeLate.closedAt);
    assert.equal(afterLate.passengerListClosedAt,beforeLate.passengerListClosedAt);
    await expectStatus(baseUrl,403,'/api/cash-transfers',{method:'PATCH',cookie:driver,body:{id:driverToSales.id,status:'accepted'}});
    await expectStatus(baseUrl,200,'/api/cash-transfers',{method:'PATCH',cookie:otherSales,body:{id:driverToSales.id,status:'accepted'}});
    const outsideTripBudget=(await expectStatus(baseUrl,201,'/api/cash-transfers',{method:'POST',cookie:otherSales,body:{toUserId:outsideDriver.id,tripId:null,amountDKK:80,amountEUR:0,note:'Budget uden bestemt tur'}})).value;
    assert.equal(outsideTripBudget.transferType,'general_driver_budget');
    assert.equal(outsideTripBudget.toUserId,outsideDriver.id);
    assert.deepEqual(outsideTripBudget.paymentRefs,[]);
    await expectStatus(baseUrl,200,'/api/cash-transfers',{method:'PATCH',cookie:outsideDriverCookie,body:{id:outsideTripBudget.id,status:'accepted'}});
    const outsideDriverCashbox=(await expectStatus(baseUrl,200,'/api/my-cashbox',{cookie:outsideDriverCookie})).value;
    assert.deepEqual(outsideDriverCashbox.summary.available,{DKK:80,EUR:0});
    assert.deepEqual(outsideDriverCashbox.summary.budgetTotals,{DKK:80,EUR:0});
    assert.ok(outsideDriverCashbox.transferable.some(item=>item.kind==='budget'&&item.name==='Budget fra salgschef'));
    await expectStatus(baseUrl,409,`/api/drivers/${outsideDriver.id}`,{method:'DELETE',cookie:admin});
    await expectStatus(baseUrl,200,`/api/trips/${closureTrip.id}`,{method:'PATCH',cookie:admin,body:{status:'planned',reopenReason:'Testen fortsætter med en ny driftsudgift'}});

    const forwardReceipt=`data:image/png;base64,${Buffer.from('forwarded-expense-receipt').toString('base64')}`;
    const forwardedExpense=(await expectStatus(baseUrl,201,`/api/trips/${closureTrip.id}/expenses`,{method:'POST',cookie:driver,body:{category:'Parkering',description:'Bilag til salgschef',amount:25,currency:'DKK',paymentMethod:'private',receiptName:'parkering.png',receiptType:'image/png',receiptData:forwardReceipt}})).value;
    const forwarded=(await expectStatus(baseUrl,200,`/api/expenses/${forwardedExpense.id}`,{method:'PATCH',cookie:driver,body:{forwardToSalesManagerId:isolatedOtherCashbox.holder.id}})).value;
    assert.equal(forwarded.forwardedToSalesManagerId,isolatedOtherCashbox.holder.id);
    const forwardedExpenseTrip=(await expectStatus(baseUrl,200,`/api/trips/${closureTrip.id}`,{cookie:otherSales})).value;
    assert.ok(forwardedExpenseTrip.expenses.some(item=>item.id===forwardedExpense.id&&item.forwardedToSalesManagerId===isolatedOtherCashbox.holder.id));
    await expectStatus(baseUrl,200,`/api/expenses/${forwardedExpense.id}/receipt`,{cookie:otherSales});
    const salesCashboxWithReceipt=(await expectStatus(baseUrl,200,'/api/my-cashbox',{cookie:otherSales})).value;
    assert.ok(salesCashboxWithReceipt.forwardedExpenses.some(item=>item.id===forwardedExpense.id&&item.receiptFile));

    const outsideCheckInDeparture=new Date(Date.now()+90*60*1000),outsideCheckInArrival=new Date(Date.now()+3*60*60*1000);
    const outsideCheckInTrip=(await expectStatus(baseUrl,201,'/api/trips',{method:'POST',cookie:admin,body:{title:'Check-in endnu lukket',departureAt:outsideCheckInDeparture.toISOString(),destinationArrivalAt:outsideCheckInArrival.toISOString(),originId:origin.id,destinationId:destination.id,busId:doubleBus.id,primaryDriverId:2}})).value;
    const beforeAutomaticCheckIn=(await expectStatus(baseUrl,200,`/api/trips/${outsideCheckInTrip.id}`,{cookie:driver})).value.trip;
    assert.equal(beforeAutomaticCheckIn.operationalPhase,'planned');
    assert.equal(beforeAutomaticCheckIn.boardingStartedAt,null);
    assert.equal(beforeAutomaticCheckIn.checkInOpensAt,new Date(outsideCheckInDeparture.getTime()-60*60*1000).toISOString());

    const automaticBoardingDeparture=new Date(Date.now()+30*60*1000),automaticBoardingArrival=new Date(Date.now()+2*60*60*1000);
    const automaticBoardingTrip=(await expectStatus(baseUrl,201,'/api/trips',{method:'POST',cookie:admin,body:{title:'Automatisk check-in',departureAt:automaticBoardingDeparture.toISOString(),destinationArrivalAt:automaticBoardingArrival.toISOString(),originId:origin.id,destinationId:destination.id,busId:doubleBus.id,primaryDriverId:2}})).value;
    const automaticallyBoarding=(await expectStatus(baseUrl,200,`/api/trips/${automaticBoardingTrip.id}`,{cookie:driver})).value.trip;
    assert.equal(automaticallyBoarding.operationalPhase,'boarding');
    assert.equal(automaticallyBoarding.boardingSource,'schedule');
    assert.equal(automaticallyBoarding.boardingStartedAt,new Date(automaticBoardingDeparture.getTime()-60*60*1000).toISOString());
    assert.equal(automaticallyBoarding.startedAt,null);
    const automaticBoardingAudit=(await expectStatus(baseUrl,200,`/api/audit?tripId=${automaticBoardingTrip.id}`,{cookie:admin})).value;
    assert.ok(automaticBoardingAudit.events.some(event=>event.action==='trip.boarding_opened_automatically'&&event.userName==='System'));

    const autoStartDeparture=new Date(Date.now()-60*1000),autoStartArrival=new Date(Date.now()+60*60*1000);
    const autoStartTrip=(await expectStatus(baseUrl,201,'/api/trips',{method:'POST',cookie:admin,body:{title:'Automatisk turstart',departureAt:autoStartDeparture.toISOString(),destinationArrivalAt:autoStartArrival.toISOString(),originId:origin.id,destinationId:destination.id,busId:doubleBus.id,primaryDriverId:2}})).value;
    const automaticallyStarted=(await expectStatus(baseUrl,200,`/api/trips/${autoStartTrip.id}`,{cookie:driver})).value.trip;
    assert.equal(automaticallyStarted.operationalPhase,'underway');
    assert.equal(automaticallyStarted.startSource,'schedule');
    assert.equal(automaticallyStarted.startedAt,autoStartDeparture.toISOString());
    assert.equal(automaticallyStarted.boardingStartedAt,new Date(autoStartDeparture.getTime()-60*60*1000).toISOString());
    assert.equal(automaticallyStarted.startedByName,null);
    assert.equal(automaticallyStarted.arrivedAt,null);
    const automaticStartAudit=(await expectStatus(baseUrl,200,`/api/audit?tripId=${autoStartTrip.id}`,{cookie:admin})).value;
    assert.ok(automaticStartAudit.events.some(event=>event.action==='trip.boarding_opened_automatically'&&event.userName==='System'));
    assert.ok(automaticStartAudit.events.some(event=>event.action==='trip.started_automatically'&&event.userName==='System'));

    const autoArrivalDeparture=new Date(Date.now()-2*60*60*1000),autoArrivalDeadline=new Date(Date.now()-60*60*1000);
    const autoArrivalTrip=(await expectStatus(baseUrl,201,'/api/trips',{method:'POST',cookie:admin,body:{title:'Automatisk ankomst',departureAt:autoArrivalDeparture.toISOString(),destinationArrivalAt:autoArrivalDeadline.toISOString(),originId:origin.id,destinationId:destination.id,busId:doubleBus.id,primaryDriverId:2}})).value;
    const automaticallyArrived=(await expectStatus(baseUrl,200,`/api/trips/${autoArrivalTrip.id}`,{cookie:driver})).value.trip;
    assert.equal(automaticallyArrived.operationalPhase,'arrived');
    assert.equal(automaticallyArrived.status,'planned');
    assert.equal(automaticallyArrived.startSource,'schedule');
    assert.equal(automaticallyArrived.arrivalSource,'schedule');
    assert.equal(automaticallyArrived.arrivedAt,autoArrivalDeadline.toISOString());
    assert.equal(automaticallyArrived.arrivedByName,null);
    const automaticArrivalAudit=(await expectStatus(baseUrl,200,`/api/audit?tripId=${autoArrivalTrip.id}`,{cookie:admin})).value;
    assert.ok(automaticArrivalAudit.events.some(event=>event.action==='trip.started_automatically'&&event.userName==='System'));
    assert.ok(automaticArrivalAudit.events.some(event=>event.action==='trip.arrived_automatically'&&event.userName==='System'));

    await expectStatus(baseUrl,403,`/api/trips/${trip.id}`,{method:'DELETE',cookie:driver,body:{confirmation:'SLET',deletionReason:'Test af rollebeskyttelse'}});
    await expectStatus(baseUrl,409,`/api/trips/${trip.id}`,{method:'DELETE',cookie:admin,body:{confirmation:'forkert',deletionReason:'Test af bekræftelse'}});
    const deletedCancelledTrip=(await expectStatus(baseUrl,200,`/api/trips/${trip.id}`,{method:'DELETE',cookie:admin,body:{confirmation:'SLET',deletionReason:'Den annullerede testtur skal ryddes permanent'}})).value;
    assert.equal(deletedCancelledTrip.ok,true);
    assert.ok(deletedCancelledTrip.deleted.passengers>0);
    assert.ok(deletedCancelledTrip.deleted.baggage>0);
    assert.ok(deletedCancelledTrip.deleted.expenses>0);
    await expectStatus(baseUrl,404,`/api/trips/${trip.id}`,{cookie:admin});
    const deletionAudit=(await expectStatus(baseUrl,200,`/api/audit?tripId=${trip.id}`,{cookie:admin})).value;
    assert.ok(deletionAudit.events.some(event=>event.action==='trip.deleted'&&event.details.reason==='Den annullerede testtur skal ryddes permanent'));

    const ownAdminProfile=(await expectStatus(baseUrl,200,'/api/profile',{method:'PATCH',cookie:admin,body:{email:'administrator-ny@albaturist.dk',currentPassword:'admin123',newPassword:'administratorens-nye-kode'}})).value;
    assert.equal(ownAdminProfile.user.email,'administrator-ny@albaturist.dk');
    await expectStatus(baseUrl, 200, '/api/logout', { method: 'POST', cookie: admin });
    await expectStatus(baseUrl, 401, '/api/me', { cookie: admin });
    await expectStatus(baseUrl,401,'/api/login',{method:'POST',body:{email:'admin@albaturist.dk',password:'admin123'}});
    await expectStatus(baseUrl,200,'/api/login',{method:'POST',body:{email:'administrator-ny@albaturist.dk',password:'administratorens-nye-kode'}});
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test('responsive check-in controls stay inside the visible workspace', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  assert.match(styles, /\.content\{overflow-x:hidden\}/);
  assert.match(styles, /\.table-scroll\{width:100%;max-width:100%;overflow-x:auto\}/);
  assert.match(styles, /\.checkin-group\{overflow:visible\}/);
  assert.match(styles, /@media\(min-width:701px\)\{\.checkin-more\.open-up>div\{top:auto;bottom:44px\}\}/);
  assert.match(styles, /\.checkin-more>div\{position:fixed;left:12px;right:12px;top:auto;bottom:calc\(80px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(app, /panelRect\.bottom>window\.innerHeight-12\|\|panelRect\.bottom>groupRect\.bottom-8/);
  assert.match(app, /if\(other!==menu\)other\.open=false/);
  assert.match(app, /COPENHAGEN_TIME_ZONE='Europe\/Copenhagen'/);
  assert.match(app, /data\.departureAt=copenhagenDateFromInput\(data\.departureAt\)\.toISOString\(\)/);
  assert.match(app, /data\.destinationArrivalAt=copenhagenDateFromInput\(data\.destinationArrivalAt\)\.toISOString\(\)/);
  assert.match(app, /departureInput\?copenhagenDateFromInput\(departureInput\.value\)\.toISOString\(\):arrivalAt/);
  assert.match(html, /name="destinationArrivalAt" type="datetime-local" required/);
  assert.match(app, /Startstedet har kun afgang, slutstedet har kun forventet ankomst/);
  assert.match(app, /<small>SÆDE NR\.<\/small>/);
  assert.match(app, /checkin-name-label">NAVN/);
  assert.match(app, /checkin-pickup"><small>OPSAMLINGSSTED/);
  assert.match(app, /checkin-destination"><small>DESTINATION/);
  assert.match(app, /data-passenger-actions="\$\{p\.id\}"/);
  assert.match(app, /function showPassengerActionSheet/);
  assert.match(app, /function performManualUncheck/);
  assert.match(app, /data-sheet-action="uncheck"/);
  assert.match(app, /Fjern check-in/);
  assert.doesNotMatch(app, /Fortryd \(\$\{seconds\}\)/);
  assert.doesNotMatch(app, /function undoLastCheckIn/);
  assert.match(app, /state\.currentCheckinStop=passenger\.pickupStopId;state\.checkInListFilter='pending'/);
  assert.match(app, /Alle passagerer · hele turen/);
  assert.match(app, /function renderAllPassengerCheckIn\(\)/);
  assert.match(app, /state\.checkInAllPassengers=event\.target\.value==='all'/);
  assert.match(app, /Alle opsamlingssteder vises samlet/);
  assert.match(app, /function setupCheckInListFilters\(\)/);
  assert.match(app, /checked:visiblePassengers\.filter\(passenger=>passenger\.checkedIn\)\.length/);
  assert.match(app, /renderAllPassengerCheckIn\(\);[\s\S]*setupCheckInListFilters\(\)/);
  assert.doesNotMatch(app, /Forventet varighed/);
  assert.doesNotMatch(app, /name="durationMinutes"/);
  assert.doesNotMatch(html, /Grundpris/);
  assert.doesNotMatch(html, /name="basePrice"/);
  assert.match(app, /data-delete-record="\$\{kind\}:\$\{id\}"/);
  assert.match(app, /method:'DELETE',body:JSON\.stringify\(\{id,deletionReason:reason\}\)/);
  assert.match(app, /Slet annulleret tur/);
  assert.match(app, /confirmation:form\.confirmation\.value,deletionReason/);
  assert.match(styles, /\.deletion-zone\{/);
  assert.match(styles, /@media\(max-width:700px\).*\.checkin-actions\{display:none!important\}/s);
  assert.match(styles, /\.checkin-card\{grid-template-columns:62px minmax\(180px,1fr\)\}\.checkin-payment,\.checkin-actions\{display:none!important\}/);
  assert.match(app, /<span>Betaling <b>\$\{paymentStatus\}<\/b><\/span>/);
  assert.match(app, /p\.paymentStatus==='cash'\?'Betaling registreret':'Betaling mangler'/);
  assert.match(app, /aria-label="Sædeplan for dobbeltdækkerbus"/);
  assert.match(app, /<strong>Overetage<\/strong><small>62 sæder/);
  assert.match(app, /<strong>Underetage<\/strong><small>22 sæder/);
  assert.match(app, /2 BORDGRUPPER · 4 PERSONER VED HVERT BORD/);
  assert.match(styles, /\.double-decker-map \.setra-deck \.seat\.taken\{[^}]*background:#d93d49/);
  assert.match(styles, /@media\(max-width:850px\)\{\.double-decker-map \.setra-decks\{grid-template-columns:1fr\}/);
  assert.match(app, /function upcomingStopTimes\(stopId\)/);
  assert.match(app, /Steder og kommende tider/);
  assert.match(app, /Alle tider vises i København-tid/);
  assert.match(styles, /@media\(max-width:650px\)\{\.stop-schedule-list\{padding:8px\}/);
  assert.match(app, /isEnd=Number\(row\.stopId\)===Number\(trip\.destinationId\)/);
  assert.match(app, /Startsted · kun afgang/);
  assert.match(app, /Slutsted · kun forventet ankomst/);
  assert.match(styles, /\.timetable-stop\.destination-only/);
  assert.match(app, /function openPictureSeatPicker\(form\)/);
  assert.match(app, /function openStandardSeatPicker\(form\)/);
  assert.match(app, /function pickerExtraSeatChoice\(primarySeatNumber,extraSeatNumber\)/);
  assert.match(app, /Tilføj ekstra sæde/);
  assert.match(app, /name="extraSeatRequested"/);
  assert.match(app, /Bestil et ekstra sæde ved siden af/);
  assert.match(app, /function openSeatPickerWithAutomaticExtra/);
  assert.match(app, /form\.cashAmount\.disabled=!isCash/);
  assert.match(styles, /\.extra-seat-request\{/);
  assert.match(app, /async function renderSalesCashbox\(\)/);
  assert.match(app, /api\/my-cashbox/);
  assert.match(app, /Min budgetkasse/);
  assert.match(app, /function budgetAmountFields/);
  assert.match(app, /Separat budgetoverførsel/);
  assert.match(app, /Chaufføren ser kun beløb, valuta, formål og kvitteringsnummer/);
  assert.match(styles, /\.personal-cashbox-hero\{/);
  assert.match(app, /Indtast passagerens navn, før sædeplanen åbnes/);
  assert.match(app, /\['admin','sales_manager','driver'\]\.includes\(state\.user\?\.role\)/);
  assert.match(app, /picture-left-scroll/);
  assert.match(app, /Alle oprettede opsamlingssteder kan vælges – også stoppesteder undervejs/);
  assert.match(app, /Sædeplan – Dobbeltdækkerbus/);
  assert.match(app, /pictureTripInfo\(\).*pictureLegend\(\)/s);
  assert.match(app, /pictureUpperDeck\(upper,pendingSeat\).*pictureLowerDeck\(lower,pendingSeat\)/s);
  assert.match(app, /picture-table-group picture-table-group-\$\{index\}/);
  assert.match(app, /index===0\?\[\.\.\.seats\.slice\(0,2\),\.\.\.seats\.slice\(4,6\)\]/);
  assert.match(app, /picture-lower-front.*picture-stairs tall.*picture-magazine">Magasin.*picture-tables/s);
  assert.match(styles, /\.lower-front-layout \.luggage,\.picture-lower-front \.picture-magazine\{align-self:stretch/);
  assert.match(styles, /\.seat-picker-dialog\{inset:8px;max-width:none/);
  assert.match(styles, /\.picture-left\{grid-template-rows:minmax\(0,1fr\) auto;align-content:stretch;overflow:hidden\}/);
  assert.match(styles, /\.picture-continue\{position:relative;z-index:2;width:100%/);
  assert.match(styles, /@media\(max-width:950px\)\{\.seat-picker-dialog\{inset:0;width:100%;height:100%/);
});

test('official Alba Turist logo is bundled into the login background', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const translations = fs.readFileSync(path.join(__dirname, '..', 'public', 'translations.js'), 'utf8');
  const logo = path.join(__dirname, '..', 'public', 'assets', 'alba-turist-logo.jpg');
  assert.match(html, /\/assets\/alba-turist-logo\.jpg/);
  assert.match(css, /login-official-logo/);
  assert.ok(fs.existsSync(logo));
  assert.ok(fs.statSync(logo).size > 1000);
  assert.doesNotMatch(html, /Demo-login|chauffor123|admin123/);
  assert.match(html, /Husk mig på denne enhed/);
  assert.match(app, /accountNav\.dataset\.view='account'/);
  assert.match(app, /\/api\/profile/);
  assert.match(app, /\/api\/profile\/language/);
  assert.match(app, /Dansk/);
  assert.match(app, /Shqip/);
  assert.match(app, /Deutsch/);
  assert.match(app, /English/);
  assert.match(app, /MutationObserver/);
  assert.match(html, /translations\.js.*app\.js/);
  assert.match(app, /BUSOPS_TRANSLATIONS/);
  assert.match(app, /dynamicTranslationPatterns/);
  assert.match(translations, /Busser i flåden.*Busse in der Flotte.*Buses in the fleet/);
  assert.match(translations, /AKTUELT OPSAMLINGSSTED.*AKTUELLE HALTESTELLE.*CURRENT PICKUP POINT/);
  assert.match(translations, /Registrer udgift.*Ausgabe erfassen.*Record expense/);
  assert.match(app, /accountNav\.onclick=\(\)=>renderAccount\(\)/);
  assert.match(app, /function keepActiveControlVisible/);
  assert.match(app, /\.tabs \.tab\.active/);
  assert.match(css, /Fælles responsiv kvalitetssikring/);
  assert.match(css, /#view button:not\(\.seat\):not\(\.picture-seat\)/);
  assert.match(css, /dialog:not\(\.seat-picker-dialog\)\{width:calc\(100% - 16px\)/);
  assert.match(app, /Kun du kan ændre din e-mail og adgangskode/);
});
