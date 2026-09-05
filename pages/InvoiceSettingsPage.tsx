import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Save } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { toast } from '../components/ui/Toaster';

export type InvoiceSettings = {
    prefix: string;
    suffix: string;
    padding: number;
};

export const getInvoiceSettings = (): InvoiceSettings => {
    const saved = localStorage.getItem('invoiceSettings');
    if (saved) {
        try {
            return JSON.parse(saved);
        } catch (e) {
            console.error('Error parsing invoice settings', e);
        }
    }
    return { prefix: 'INV-', suffix: '', padding: 3 };
};

const InvoiceSettingsPage: React.FC = () => {
    const [prefix, setPrefix] = useState('INV-');
    const [suffix, setSuffix] = useState('');
    const [padding, setPadding] = useState('3');

    useEffect(() => {
        const settings = getInvoiceSettings();
        setPrefix(settings.prefix);
        setSuffix(settings.suffix);
        setPadding(settings.padding.toString());
    }, []);

    const handleSave = () => {
        const paddingNum = parseInt(padding, 10);
        if (isNaN(paddingNum) || paddingNum < 1 || paddingNum > 10) {
            toast('Padding must be a number between 1 and 10.');
            return;
        }
        
        const newSettings: InvoiceSettings = {
            prefix,
            suffix,
            padding: paddingNum
        };
        localStorage.setItem('invoiceSettings', JSON.stringify(newSettings));
        toast('Invoice settings saved successfully!');
    };

    const previewNumber = '1'.padStart(parseInt(padding, 10) || 3, '0');

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-4">
                <Link to="/settings" className="p-2 rounded-md hover:bg-gray-200 dark:hover:bg-gray-700">
                    <ArrowLeft className="w-6 h-6" />
                </Link>
                <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-600 via-indigo-500 to-purple-600 bg-clip-text text-transparent">
                    Invoice Preferences
                </h1>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>Invoice Number Format</CardTitle>
                    <CardDescription>
                        Configure how new invoice numbers are automatically generated.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                        <div className="space-y-2">
                            <label htmlFor="prefix" className="block text-sm font-medium mb-1 text-slate-700 dark:text-slate-300">Prefix</label>
                            <Input
                                id="prefix"
                                placeholder="e.g. BTC-"
                                value={prefix}
                                onChange={(e) => setPrefix(e.target.value)}
                            />
                        </div>
                        <div className="space-y-2">
                            <label htmlFor="padding" className="block text-sm font-medium mb-1 text-slate-700 dark:text-slate-300">Number Length (Padding)</label>
                            <Input
                                id="padding"
                                type="number"
                                min="1"
                                max="10"
                                placeholder="e.g. 3"
                                value={padding}
                                onChange={(e) => setPadding(e.target.value)}
                            />
                            <p className="text-xs text-slate-500">How many digits the number should have (e.g. 3 = 001)</p>
                        </div>
                        <div className="space-y-2">
                            <label htmlFor="suffix" className="block text-sm font-medium mb-1 text-slate-700 dark:text-slate-300">Suffix</label>
                            <Input
                                id="suffix"
                                placeholder="e.g. /26-27"
                                value={suffix}
                                onChange={(e) => setSuffix(e.target.value)}
                            />
                        </div>
                    </div>

                    <div className="p-4 bg-slate-50 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
                        <p className="text-sm text-slate-500 mb-2">Preview of next invoice number:</p>
                        <p className="text-2xl font-mono font-semibold text-slate-800 dark:text-slate-200">
                            {prefix}{previewNumber}{suffix}
                        </p>
                    </div>

                    <div className="flex justify-end">
                        <Button onClick={handleSave} className="flex items-center gap-2">
                            <Save className="w-4 h-4" /> Save Settings
                        </Button>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
};

export default InvoiceSettingsPage;
