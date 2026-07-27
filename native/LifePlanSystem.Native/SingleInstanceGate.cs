namespace LifePlanSystem.Native;

internal sealed class SingleInstanceGate : IDisposable
{
    private readonly Mutex _mutex;
    private readonly bool _owns;

    private SingleInstanceGate(Mutex mutex, bool owns)
    {
        _mutex = mutex;
        _owns = owns;
    }

    public static SingleInstanceGate? TryAcquire()
    {
        var mutex = new Mutex(initiallyOwned: true, @"Local\Daa13x.LifePlanSystem.Native", out var created);
        return created ? new SingleInstanceGate(mutex, owns: true) : null;
    }

    public void Dispose()
    {
        if (_owns) _mutex.ReleaseMutex();
        _mutex.Dispose();
    }
}
