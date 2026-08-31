<?php
namespace App\Http\Controllers;
use App\Models\{Absence,ActivityLog,BusTask,Customer,Deviation,MailImport,OutlookConnection,User};
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Validation\Rule;

class BusOpsController extends Controller {
    private function admin(Request $r): void { abort_unless($r->user()->role==='admin',403); }
    private function log(Request $r,string $action,?BusTask $task=null,array $details=[]): void { ActivityLog::create(['user_id'=>$r->user()->id,'action'=>$action,'subject_type'=>$task?'bus_task':null,'subject_id'=>$task?->id,'details'=>$details]); }
    public function dashboard(Request $r) {
        $q=BusTask::with(['customer','employee','deviations'])->latest('scheduled_at');
        if($r->user()->role==='employee') $q->where('employee_id',$r->user()->id);
        if($r->user()->role==='customer') {
            $customerId=Customer::where('email',$r->user()->email)->value('id');
            $q->where('customer_id',$customerId);
        }
        $customers=$r->user()->role==='customer'?Customer::where('email',$r->user()->email)->get():Customer::all();
        $tasks=$q->limit(100)->get();
        if($r->user()->role==='customer') $tasks->each->makeHidden(['notes','deviations']);
        return ['user'=>$r->user(),'tasks'=>$tasks,'customers'=>$customers,'employees'=>User::where('role','employee')->get(),
            'absences'=>$r->user()->role==='admin'?Absence::with('user')->latest()->get():($r->user()->role==='employee'?Absence::where('user_id',$r->user()->id)->orderBy('starts_on')->get():[]),
            'history'=>$r->user()->role==='admin'?ActivityLog::latest()->limit(40)->get():[],
            'mail_imports'=>$r->user()->role==='admin'?MailImport::with('items')->latest()->limit(30)->get():[],
            'outlook'=>$r->user()->role==='admin'?['configured'=>(bool)config('services.microsoft.client_id'),'connection'=>OutlookConnection::where('user_id',$r->user()->id)->first(['email','updated_at']),'ocr_ready'=>is_file((string)config('services.ocr.tesseract')),'error'=>$r->session()->pull('outlook_oauth_error')]:null];
    }
    public function storeTask(Request $r) {
        abort_unless(in_array($r->user()->role,['admin','customer']),403);
        $d=$r->validate(['customer_id'=>'required|exists:customers,id','bus_number'=>'required|max:50','pickup_location'=>'required|max:255','scheduled_at'=>'required|date','notes'=>'nullable|string']);
        if($r->user()->role==='customer') {
            $d['customer_id']=Customer::where('email',$r->user()->email)->value('id') ?? abort(422,'Kundekontoen er ikke knyttet til en kunde.');
        }
        $passenger=in_array(mb_strtolower($d['pickup_location']),['københavns lufthavn','malmö station']);
        $task=BusTask::create($d+['dropoff_location'=>'Københavns Busterminal','created_by'=>$r->user()->id,'task_type'=>$passenger?'passenger':'out','requires_driving_license'=>$passenger,'status'=>'unassigned']);
        $this->log($r,'Opgave oprettet',$task); return response()->json($task->load('customer'),201);
    }
    public function updateTask(Request $r,BusTask $task) {
        $isOwner=$r->user()->role==='customer'&&$task->customer()->where('email',$r->user()->email)->exists();
        abort_unless($r->user()->role==='admin'||$isOwner,403);
        if($isOwner) {
            abort_unless(in_array($task->status,['unassigned','assigned','picked_up']),422,'En afsluttet eller aflyst opgave kan ikke ændres.');
            $d=$r->validate(['bus_number'=>'sometimes|required|string|max:50','scheduled_at'=>'sometimes|required|date']);
            abort_if(isset($d['scheduled_at'])&&!in_array($task->status,['unassigned','assigned']),422,'Ankomsttiden kan ikke ændres, efter bussen er hentet.');
            abort_if(!$d,422,'Der blev ikke sendt nogen ændringer.');
            $old=['bus_number'=>$task->bus_number,'scheduled_at'=>$task->scheduled_at?->toISOString()];
            $task->update($d);
            $this->log($r,isset($d['scheduled_at'])?'Ankomsttid ændret':'Erstatningsbus registreret',$task,['fra'=>$old,'til'=>$d]);
            return $task->fresh(['customer','employee']);
        }
        $d=$r->validate(['bus_number'=>'sometimes|string|max:50','scheduled_at'=>'sometimes|date','pickup_location'=>'sometimes|string','delay_minutes'=>'sometimes|integer|min:0|max:1440','notes'=>'nullable|string']);
        if(isset($d['pickup_location'])) { $passenger=in_array(mb_strtolower($d['pickup_location']),['københavns lufthavn','malmö station']); $d+=['task_type'=>$passenger?'passenger':'out','requires_driving_license'=>$passenger]; }
        $d['dropoff_location']='Københavns Busterminal';
        $task->update($d); $this->log($r,'Opgave ændret',$task,$d); return $task->fresh(['customer','employee']);
    }
    public function assign(Request $r,BusTask $task) { $this->admin($r); abort_if(in_array($task->status,['picked_up','delivered','cancelled']),422,'Medarbejderen kan ikke skiftes, efter opgaven er påbegyndt eller afsluttet.'); $d=$r->validate(['employee_id'=>'required|exists:users,id']); $employee=User::where('role','employee')->findOrFail($d['employee_id']); abort_if($task->requires_driving_license&&!$employee->has_driving_license,422,'Opgaven kræver førerkort.'); $previous=$task->employee?->name; $task->update(['employee_id'=>$employee->id,'status'=>'assigned']); $this->log($r,$previous?'Medarbejder skiftet':'Medarbejder tildelt',$task,['fra'=>$previous,'til'=>$employee->name]); return $task->fresh('employee'); }
    public function suggest(Request $r,BusTask $task) { $this->admin($r); $busy=BusTask::whereDate('scheduled_at',$task->scheduled_at)->whereNotNull('employee_id')->pluck('employee_id'); $q=User::where('role','employee')->whereNotIn('id',$busy); if($task->requires_driving_license)$q->where('has_driving_license',true); $employee=$q->first(); return $employee?:response()->json(['message'=>'Ingen ledig kvalificeret medarbejder fundet.'],422); }
    public function status(Request $r,BusTask $task) {
        abort_unless($r->user()->role==='admin'||$task->employee_id===$r->user()->id,403);
        $d=$r->validate(['status'=>['required',Rule::in(['picked_up','delivered'])],'actual_pickup_location'=>'nullable|string|max:255']);
        if(array_key_exists('actual_pickup_location',$d)) abort_unless($r->user()->role==='employee'&&$task->employee_id===$r->user()->id,403,'Kun den tildelte medarbejder kan registrere det faktiske afhentningssted.');
        $now=now(); $wasPickedUp=(bool)$task->picked_up_at; $changes=['status'=>$d['status']];
        if($d['status']==='picked_up') $changes['picked_up_at']=$now;
        if($d['status']==='delivered') { $changes['picked_up_at']=$task->picked_up_at??$now; $changes['delivered_at']=$now; }
        if($r->user()->role==='employee') $changes['actual_pickup_location']=$d['actual_pickup_location']??$task->actual_pickup_location??$task->pickup_location;
        $task->update($changes);
        $directCompletion=$d['status']==='delivered'&&!$wasPickedUp;
        $this->log($r,$directCompletion?'Bus hentet og opgave udført':($d['status']==='picked_up'?'Bus hentet':'Opgave udført'),$task,['aftalt_sted'=>$task->pickup_location,'faktisk_sted'=>$changes['actual_pickup_location']??$task->actual_pickup_location]);
        return $task->fresh(['customer','employee']);
    }
    public function undoPickup(Request $r,BusTask $task) {
        abort_unless($r->user()->role==='employee'&&$task->employee_id===$r->user()->id,403);
        abort_unless(in_array($task->status,['picked_up','delivered'],true),422,'Kun en registreret afhentning kan fortrydes.');
        $previous=['status'=>$task->status,'picked_up_at'=>$task->picked_up_at?->toISOString(),'delivered_at'=>$task->delivered_at?->toISOString()];
        $task->update(['status'=>'assigned','picked_up_at'=>null,'delivered_at'=>null,'actual_pickup_location'=>null]);
        $this->log($r,'Bus hentet fortrudt',$task,['før'=>$previous]);
        return $task->fresh(['customer','employee']);
    }
    public function employeeBusNumber(Request $r,BusTask $task) {
        abort_unless($r->user()->role==='employee'&&$task->employee_id===$r->user()->id,403);
        abort_if($task->status==='cancelled',422,'En aflyst opgave kan ikke rettes.');
        $data=$r->validate(['bus_number'=>'required|string|max:50']);
        $previous=$task->bus_number;
        $task->update($data);
        $this->log($r,'Busnummer rettet af medarbejder',$task,['fra'=>$previous,'til'=>$data['bus_number']]);
        return $task->fresh(['customer','employee']);
    }
    public function employeePickupTime(Request $r,BusTask $task) {
        abort_unless($r->user()->role==='employee'&&$task->employee_id===$r->user()->id,403);
        abort_unless(in_array($task->status,['picked_up','delivered'],true),422,'Registreringstiden kan kun rettes på en hentet bus.');
        $data=$r->validate(['picked_up_at'=>'required|date|before_or_equal:now']);
        $previous=$task->picked_up_at?->toISOString();
        $corrected=Carbon::parse($data['picked_up_at'])->setTimezone(config('app.timezone'));
        $task->update(['picked_up_at'=>$corrected]);
        $this->log($r,'Registreringstid rettet af medarbejder',$task,['fra'=>$previous,'til'=>$task->fresh()->picked_up_at?->toISOString()]);
        return $task->fresh(['customer','employee']);
    }
    public function actualPickupLocation(Request $r,BusTask $task) { abort_unless($r->user()->role==='employee'&&$task->employee_id===$r->user()->id,403); abort_unless(in_array($task->status,['assigned','picked_up']),422,'Afhentningsstedet kan kun ændres på en aktiv opgave.'); $d=$r->validate(['actual_pickup_location'=>'required|string|max:255']); $task->update($d); $this->log($r,'Faktisk afhentningssted ændret',$task,['aftalt_sted'=>$task->pickup_location,'faktisk_sted'=>$d['actual_pickup_location']]); return $task->fresh(['customer','employee']); }
    public function cancel(Request $r,BusTask $task) { $this->admin($r); $task->update(['status'=>'cancelled','cancelled_at'=>now()]); $this->log($r,'Opgave aflyst',$task); return $task; }
    public function destroy(Request $r,BusTask $task) {
        $isOwner=$r->user()->role==='customer'&&$task->customer()->where('email',$r->user()->email)->exists();
        abort_unless($r->user()->role==='admin'||$isOwner,403);
        if($isOwner) abort_unless(in_array($task->status,['unassigned','assigned']),422,'Opgaven er påbegyndt og kan ikke slettes.');
        $this->log($r,'Fejlopgave slettet',$task,['bus_number'=>$task->bus_number]); $task->delete(); return response()->noContent();
    }
    public function deviation(Request $r,BusTask $task) { abort_unless($r->user()->role==='admin'||$task->employee_id===$r->user()->id,403); $d=$r->validate(['category'=>'required|string','description'=>'required|string']); $item=Deviation::create($d+['bus_task_id'=>$task->id,'reported_by'=>$r->user()->id]); $this->log($r,'Afvigelse registreret',$task,$d); return response()->json($item,201); }
    public function customer(Request $r) { $this->admin($r); return Customer::create($r->validate(['name'=>'required','contact_name'=>'nullable','email'=>'nullable|email','phone'=>'nullable'])); }
    public function resetCustomerPassword(Request $r,Customer $customer) {
        $this->admin($r);
        $d=$r->validate(['password'=>'required|string|min:8|confirmed']);
        abort_if(blank($customer->email),422,'Kunden har ingen e-mailadresse.');
        $user=User::where('role','customer')->where('email',$customer->email)->first();
        abort_unless($user,422,'Der findes ingen kundelogin med denne e-mailadresse.');
        $user->update(['password'=>$d['password']]);
        $this->log($r,'Kundens adgangskode nulstillet',null,['customer_id'=>$customer->id]);
        return response()->noContent();
    }
    public function employee(Request $r) { $this->admin($r); $d=$r->validate(['name'=>'required','email'=>'required|email|unique:users','password'=>'required|min:8','phone'=>'nullable']); return User::create($d+['role'=>'employee','has_driving_license'=>true]); }
    public function updateEmployee(Request $r,User $employee) { $this->admin($r); abort_unless($employee->role==='employee',404); $d=$r->validate(['name'=>'required|string|max:255','email'=>['required','email',Rule::unique('users')->ignore($employee->id)],'phone'=>'nullable|string|max:50','password'=>'nullable|string|min:8']); if(empty($d['password']))unset($d['password']); $d['has_driving_license']=true; $employee->update($d); return $employee->fresh(); }
    public function destroyEmployee(Request $r,User $employee) { $this->admin($r); abort_unless($employee->role==='employee',404); BusTask::where('employee_id',$employee->id)->where('status','assigned')->update(['employee_id'=>null,'status'=>'unassigned']); $employee->delete(); return response()->noContent(); }
    public function absence(Request $r) { $this->admin($r); return Absence::create($r->validate(['user_id'=>'required|exists:users,id','type'=>['required',Rule::in(['day_off','absence'])],'starts_on'=>'required|date','ends_on'=>'required|date|after_or_equal:starts_on','reason'=>'nullable|string|max:255'])); }
}
