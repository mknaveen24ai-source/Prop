#!/usr/bin/env node

/**
 * Security Audit Script for PropFirm
 * Performs automated security checks and reports vulnerabilities
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class SecurityAuditor {
  constructor() {
    this.issues = [];
    this.warnings = [];
    this.passed = [];
  }

  // Add issue to report
  addIssue(severity, category, description, recommendation, file = null, line = null) {
    this.issues.push({
      severity,
      category,
      description,
      recommendation,
      file,
      line,
      timestamp: new Date().toISOString(),
    });
  }

  // Check for hardcoded secrets
  checkHardcodedSecrets() {
    console.log('🔍 Checking for hardcoded secrets...');
    
    const secretPatterns = [
      { pattern: /password\s*=\s*['"][^'"]{8,}['"]/, type: 'Password' },
      { pattern: /secret\s*=\s*['"][^'"]{16,}['"]/, type: 'Secret key' },
      { pattern: /api_key\s*=\s*['"][^'"]{16,}['"]/, type: 'API key' },
      { pattern: /token\s*=\s*['"][^'"]{16,}['"]/, type: 'Token' },
      { pattern: /jwt_secret\s*=\s*['"][^'"]{16,}['"]/, type: 'JWT secret' },
    ];

    this.scanFiles('**/*.js', secretPatterns, (match, filePath, line) => {
      this.addIssue(
        'HIGH',
        'Hardcoded Secrets',
        `Found hardcoded ${match.type} in code`,
        'Move secrets to environment variables',
        filePath,
        line
      );
    });
  }

  // Check for SQL injection vulnerabilities
  checkSQLInjection() {
    console.log('🔍 Checking for SQL injection vulnerabilities...');
    
    const sqlPatterns = [
      { pattern: /\$\{.*\}/, type: 'Template literal injection' },
      { pattern: /\+.*\+.*WHERE/, type: 'String concatenation in SQL' },
      { pattern: /concat\(.*WHERE/, type: 'Concat function in SQL' },
      { pattern: /SELECT.*\+.*FROM/, type: 'String concatenation in SELECT' },
    ];

    this.scanFiles('**/*.js', sqlPatterns, (match, filePath, line) => {
      this.addIssue(
        'HIGH',
        'SQL Injection',
        `Potential SQL injection: ${match.type}`,
        'Use parameterized queries with prepared statements',
        filePath,
        line
      );
    });
  }

  // Check for XSS vulnerabilities
  checkXSS() {
    console.log('🔍 Checking for XSS vulnerabilities...');
    
    const xssPatterns = [
      { pattern: /innerHTML\s*=/, type: 'innerHTML assignment' },
      { pattern: /document\.write/, type: 'document.write usage' },
      { pattern: /eval\s*\(/, type: 'eval() usage' },
      { pattern: /dangerouslySetInnerHTML/, type: 'React dangerous HTML' },
    ];

    this.scanFiles('**/*.js', xssPatterns, (match, filePath, line) => {
      this.addIssue(
        'MEDIUM',
        'Cross-Site Scripting',
        `Potential XSS vulnerability: ${match.type}`,
        'Use proper HTML sanitization and avoid dangerous DOM manipulation',
        filePath,
        line
      );
    });
  }

  // Check for insecure dependencies
  checkDependencies() {
    console.log('🔍 Checking for insecure dependencies...');
    
    try {
      const auditResult = execSync('npm audit --json', { encoding: 'utf8' });
      const audit = JSON.parse(auditResult);
      
      if (audit.vulnerabilities) {
        Object.entries(audit.vulnerabilities).forEach(([pkg, vuln]) => {
          vuln.forEach(v => {
            this.addIssue(
              v.severity === 'high' ? 'HIGH' : v.severity === 'moderate' ? 'MEDIUM' : 'LOW',
              'Insecure Dependencies',
              `Vulnerable package: ${pkg} (${v.severity}) - ${v.title}`,
              `Run: npm audit fix`,
              'package.json'
            );
          });
        });
      }
    } catch (error) {
      this.addIssue(
        'LOW',
        'Dependency Check Failed',
        'Could not run npm audit',
        'Ensure npm is installed and package.json exists'
      );
    }
  }

  // Check for insecure configurations
  checkConfiguration() {
    console.log('🔍 Checking for insecure configurations...');
    
    const configFiles = ['.env', 'config.js', 'config.json'];
    
    configFiles.forEach(file => {
      const filePath = path.join(process.cwd(), file);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        
        // Check for development settings in production
        if (content.includes('NODE_ENV=production') && content.includes('debug=true')) {
          this.addIssue(
            'MEDIUM',
            'Insecure Configuration',
            'Debug mode enabled in production',
            'Disable debug mode in production environment',
            file
          );
        }
        
        // Check for weak JWT secrets
        if (content.includes('JWT_SECRET=') && content.includes('JWT_SECRET=secret')) {
          this.addIssue(
            'HIGH',
            'Weak JWT Secret',
            'Default or weak JWT secret detected',
            'Use a strong, randomly generated JWT secret',
            file
          );
        }
      }
    });
  }

  // Check for proper error handling
  checkErrorHandling() {
    console.log('🔍 Checking for error handling...');
    
    const errorPatterns = [
      { pattern: /console\.log.*error/, type: 'console.log for errors' },
      { pattern: /console\.error.*stack/, type: 'Stack trace exposure' },
    ];

    this.scanFiles('**/*.js', errorPatterns, (match, filePath, line) => {
      this.addIssue(
        'LOW',
        'Error Handling',
        `Improper error handling: ${match.type}`,
        'Use proper logging library and avoid exposing stack traces',
        filePath,
        line
      );
    });
  }

  // Scan files for patterns
  scanFiles(pattern, searchPatterns, callback) {
    const glob = require('glob');
    const files = glob.sync(pattern, { ignore: ['node_modules/**', 'logs/**'] });
    
    files.forEach(filePath => {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        
        lines.forEach((line, index) => {
          searchPatterns.forEach(searchPattern => {
            if (searchPattern.pattern.test(line)) {
              callback(searchPattern, filePath, index + 1);
            }
          });
        });
      } catch (error) {
        // Skip files that can't be read
      }
    });
  }

  // Check file permissions
  checkFilePermissions() {
    console.log('🔍 Checking file permissions...');
    
    const sensitiveFiles = ['.env', 'config.json', 'private.key'];
    
    sensitiveFiles.forEach(file => {
      const filePath = path.join(process.cwd(), file);
      if (fs.existsSync(filePath)) {
        try {
          const stats = fs.statSync(filePath);
          const mode = stats.mode;
          
          // Check if file is readable by others
          if (mode & 0o044) {
            this.addIssue(
              'HIGH',
              'File Permissions',
              `Sensitive file ${file} is readable by others`,
              'Restrict file permissions: chmod 600 ' + file,
              file
            );
          }
        } catch (error) {
          // Skip if can't check permissions
        }
      }
    });
  }

  // Run all security checks
  runAudit() {
    console.log('🚀 Starting security audit...\n');
    
    this.checkHardcodedSecrets();
    this.checkSQLInjection();
    this.checkXSS();
    this.checkDependencies();
    this.checkConfiguration();
    this.checkErrorHandling();
    this.checkFilePermissions();
    
    this.generateReport();
  }

  // Generate security report
  generateReport() {
    console.log('\n📊 Security Audit Report\n');
    
    const highIssues = this.issues.filter(i => i.severity === 'HIGH');
    const mediumIssues = this.issues.filter(i => i.severity === 'MEDIUM');
    const lowIssues = this.issues.filter(i => i.severity === 'LOW');
    
    console.log(`🔴 High Severity: ${highIssues.length}`);
    console.log(`🟡 Medium Severity: ${mediumIssues.length}`);
    console.log(`🟢 Low Severity: ${lowIssues.length}`);
    console.log(`✅ Total Issues: ${this.issues.length}\n`);
    
    if (highIssues.length > 0) {
      console.log('🔴 HIGH SEVERITY ISSUES:');
      highIssues.forEach(issue => {
        console.log(`  - ${issue.description}`);
        if (issue.file) console.log(`    File: ${issue.file}:${issue.line || '?'}`);
        console.log(`    Recommendation: ${issue.recommendation}\n`);
      });
    }
    
    if (mediumIssues.length > 0) {
      console.log('🟡 MEDIUM SEVERITY ISSUES:');
      mediumIssues.forEach(issue => {
        console.log(`  - ${issue.description}`);
        if (issue.file) console.log(`    File: ${issue.file}:${issue.line || '?'}`);
        console.log(`    Recommendation: ${issue.recommendation}\n`);
      });
    }
    
    if (lowIssues.length > 0) {
      console.log('🟢 LOW SEVERITY ISSUES:');
      lowIssues.forEach(issue => {
        console.log(`  - ${issue.description}`);
        if (issue.file) console.log(`    File: ${issue.file}:${issue.line || '?'}`);
        console.log(`    Recommendation: ${issue.recommendation}\n`);
      });
    }
    
    if (this.issues.length === 0) {
      console.log('✅ No security issues found! Great job!');
    } else {
      console.log('📝 Summary:');
      console.log(`  - Address ${highIssues.length} high severity issues immediately`);
      console.log(`  - Plan to fix ${mediumIssues.length} medium severity issues`);
      console.log(`  - Consider fixing ${lowIssues.length} low severity issues`);
    }
    
    // Save report to file
    const reportPath = path.join(process.cwd(), 'logs', 'security-audit.json');
    const reportData = {
      timestamp: new Date().toISOString(),
      summary: {
        high: highIssues.length,
        medium: mediumIssues.length,
        low: lowIssues.length,
        total: this.issues.length,
      },
      issues: this.issues,
    };
    
    try {
      fs.writeFileSync(reportPath, JSON.stringify(reportData, null, 2));
      console.log(`\n📁 Detailed report saved to: ${reportPath}`);
    } catch (error) {
      console.log('Could not save report to file');
    }
  }
}

// Run audit if this script is executed directly
if (require.main === module) {
  const auditor = new SecurityAuditor();
  auditor.runAudit();
}

module.exports = SecurityAuditor;
