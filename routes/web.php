<?php

use Illuminate\Support\Facades\Route;
use App\Http\Controllers\{AuthController,BusOpsController};
use App\Http\Controllers\MailImportController;

Route::view('/','app');
Route::post('/login',[AuthController::class,'login'])->name('login');
Route::get('/csrf-token', fn () => response()->json(['token' => csrf_token()]));
Route::middleware('auth')->group(function(){
    Route::post('/logout',[AuthController::class,'logout']);
    Route::put('/api/password',[AuthController::class,'changePassword']);
    Route::get('/api/dashboard',[BusOpsController::class,'dashboard']);
    Route::post('/api/tasks',[BusOpsController::class,'storeTask']);
    Route::patch('/api/tasks/{task}',[BusOpsController::class,'updateTask']);
    Route::delete('/api/tasks/{task}',[BusOpsController::class,'destroy']);
    Route::post('/api/tasks/{task}/assign',[BusOpsController::class,'assign']);
    Route::get('/api/tasks/{task}/suggest',[BusOpsController::class,'suggest']);
    Route::post('/api/tasks/{task}/status',[BusOpsController::class,'status']);
    Route::post('/api/tasks/{task}/undo-pickup',[BusOpsController::class,'undoPickup']);
    Route::patch('/api/tasks/{task}/employee-bus-number',[BusOpsController::class,'employeeBusNumber']);
    Route::patch('/api/tasks/{task}/employee-pickup-time',[BusOpsController::class,'employeePickupTime']);
    Route::patch('/api/tasks/{task}/actual-pickup-location',[BusOpsController::class,'actualPickupLocation']);
    Route::post('/api/tasks/{task}/cancel',[BusOpsController::class,'cancel']);
    Route::post('/api/tasks/{task}/deviations',[BusOpsController::class,'deviation']);
    Route::post('/api/customers',[BusOpsController::class,'customer']);
    Route::patch('/api/customers/{customer}/password',[BusOpsController::class,'resetCustomerPassword']);
    Route::post('/api/employees',[BusOpsController::class,'employee']);
    Route::patch('/api/employees/{employee}',[BusOpsController::class,'updateEmployee']);
    Route::delete('/api/employees/{employee}',[BusOpsController::class,'destroyEmployee']);
    Route::post('/api/absences',[BusOpsController::class,'absence']);
    Route::get('/admin/outlook/connect',[MailImportController::class,'connect']);
    Route::get('/admin/outlook/callback',[MailImportController::class,'callback']);
    Route::post('/api/mail-import/sync',[MailImportController::class,'sync']);
    Route::post('/api/mail-import/preview',[MailImportController::class,'preview']);
    Route::post('/api/mail-import/{import}/approve',[MailImportController::class,'approve']);
    Route::post('/api/mail-import/{import}/reject',[MailImportController::class,'reject']);
});
Route::view('/{path}','app')->where('path','^(?!api).*$');
